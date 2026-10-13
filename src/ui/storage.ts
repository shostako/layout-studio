// 保存と読み込み: シーンを JSON ファイルに書き出す・開く・新規、ブラウザ（IndexedDB）への自動保存と起動時の復元。
// 開く・新規は loadScene コマンドで履歴に積む（元に戻すで前の案に戻れる）。
// 自動保存は IndexedDB に置く。背景の画像を data URL で持つため、localStorage（5 MB ほど）では足りない。
import type { Canvas } from './canvas'
import type { Editor } from './editor'
import { createEmptyScene, type Scene } from '../core/scene'
import { parseScene, sceneFileName, serializeScene } from '../core/sceneFile'

const DB_NAME = 'layout-studio'
const STORE = 'autosave'
const KEY = 'scene'
// 読めなかった自動保存を、上書きする前に退避しておく場所
const BROKEN_KEY = 'scene-broken'
// 最後の変更からこの ms 待って保存する（ドラッグや連打のたびに書かない）
const AUTOSAVE_DELAY_MS = 500

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('このブラウザでは使えません'))
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('開けませんでした'))
  })
}

function request<T>(db: IDBDatabase, mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode)
    const req = f(tx.objectStore(STORE))
    tx.oncomplete = () => resolve(req.result)
    tx.onerror = () => reject(tx.error ?? req.error ?? new Error('保存できませんでした'))
    tx.onabort = () => reject(tx.error ?? new Error('保存できませんでした'))
  })
}

const errText = (err: unknown) =>
  err instanceof DOMException && err.name === 'QuotaExceededError'
    ? 'ブラウザの保存領域が足りません'
    : err instanceof Error
      ? err.message
      : String(err)

const clock = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`

export function mountStorage(canvas: Canvas, editor: Editor): void {
  // ---- 上の道具バー: 新規・開く・保存と、自動保存の状態 ----
  const group = document.createElement('span')
  group.className = 'group file-group'
  const mk = (label: string, title: string, onClick: () => void) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = label
    b.title = title
    b.addEventListener('click', onClick)
    group.append(b)
    return b
  }
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.json,application/json'
  input.hidden = true
  mk('新規', '空のシーンにする（元に戻すで戻せる）', () => newScene())
  mk('開く', 'シーンの JSON ファイルを開く（Ctrl+O）', () => input.click())
  mk('保存', 'シーンを JSON ファイルに書き出す（Ctrl+S）', () => saveFile())
  // 開く・新規の結果と、自動保存の状態は別の欄に出す（自動保存が開けなかった知らせを消さないように）
  const note = document.createElement('span')
  note.className = 'save-state'
  const state = document.createElement('span')
  state.className = 'save-state'
  group.append(input, note, state)
  canvas.toolbar.prepend(group)

  const show = (el: HTMLElement) => (text: string, warn = false) => {
    el.textContent = text
    el.classList.toggle('warn', warn)
  }
  // 開く・新規の知らせは、その後にシーンが変わったら消す
  let noted: Scene | null = null
  const tellNow = show(note)
  const tell = (text: string, warn = false) => {
    noted = editor.scene()
    tellNow(text, warn)
  }
  const say = show(state)

  // ---- ファイル ----
  const saveFile = () => {
    const blob = new Blob([serializeScene(editor.scene())], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = sceneFileName(new Date())
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const load = (scene: Scene, what: string) => {
    if (editor.run({ type: 'loadScene', scene })) {
      canvas.fitHome()
      tell(what)
    }
  }
  const newScene = () => load(createEmptyScene(), '新規のシーン（元に戻すで前に戻せる）')
  input.addEventListener('change', async () => {
    const f = input.files?.[0]
    input.value = ''
    if (!f) return
    const r = parseScene(await f.text())
    if (r.ok) load(r.scene, `${f.name} を開いた`)
    else tell(`${f.name} を開けません: ${r.error}`, true)
  })
  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return
    const k = e.key.toLowerCase()
    if (k === 's') saveFile()
    else if (k === 'o') input.click()
    else return
    e.preventDefault()
  })

  // ---- 自動保存 ----
  let db: IDBDatabase | null = null
  let saved: Scene | null = null // 最後に保存した（または復元した）シーン。同じものは書かない
  let timer: ReturnType<typeof setTimeout> | undefined
  let ready = false // 復元が終わるまで保存しない（空のシーンで上書きしないため）

  const autosave = async () => {
    timer = undefined
    const scene = editor.scene()
    if (!db || scene === saved) return
    try {
      await request(db, 'readwrite', (s) => s.put(serializeScene(scene), KEY))
      saved = scene
      say(`自動保存 ${clock(new Date())}`)
    } catch (err) {
      say(`自動保存できません: ${errText(err)}。「保存」でファイルに書き出してください`, true)
    }
  }
  editor.onRender(() => {
    if (noted && editor.scene() !== noted) {
      noted = null
      tellNow('')
    }
    if (!ready || editor.scene() === saved) return
    clearTimeout(timer)
    timer = setTimeout(() => void autosave(), AUTOSAVE_DELAY_MS)
  })
  // タブを閉じる直前に、待っている保存を出す（書き終わる保証はない）
  window.addEventListener('pagehide', () => {
    if (timer !== undefined) {
      clearTimeout(timer)
      void autosave()
    }
  })

  const restore = async () => {
    try {
      db = await openDb()
      const text = await request<unknown>(db, 'readonly', (s) => s.get(KEY))
      if (typeof text === 'string') {
        const r = parseScene(text)
        if (r.ok) {
          // 起動前にもう何か操作していたら、そちらを優先する
          if (editor.scene().equipment.length === 0 && !editor.scene().background) {
            editor.reset(r.scene)
            saved = r.scene
            canvas.fitHome()
            tell('前回の続きを開いた')
          }
        } else {
          await request(db, 'readwrite', (s) => s.put(text, BROKEN_KEY))
          say(`前回の自動保存を読めませんでした（${r.error}）`, true)
        }
      }
    } catch (err) {
      db = null
      say(`自動保存は使えません: ${errText(err)}`, true)
    }
    ready = true
    editor.render()
  }
  void restore()
}
