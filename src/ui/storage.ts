// 保存と読み込み: 案の束を JSON ファイルに書き出す・開く、ブラウザ（IndexedDB）への自動保存と起動時の復元。
// 開くは、ファイルの案を今の束の後ろに足す（importPlans。今の案は消えない）。
// 自動保存は IndexedDB に置く。背景の画像を data URL で持つため、localStorage（5 MB ほど）では足りない。
import type { Canvas } from './canvas'
import type { Editor } from './editor'
import type { Plans } from './plans'
import type { Scene } from '../core/scene'
import { parsePlanFile, sceneFileName, serializePlanSet } from '../core/sceneFile'

const DB_NAME = 'layout-studio'
const STORE = 'autosave'
// 案の束を書く鍵。案の束より前の自動保存（シーン 1 つ）は OLD_KEY にあり、起動時に案 1 つとして読む
const KEY = 'plans'
const OLD_KEY = 'scene'
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

export function mountStorage(canvas: Canvas, editor: Editor, plans: Plans): void {
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
  mk('開く', 'JSON ファイルを開き、中の案を足す（Ctrl+O。今の案は残る）', () => input.click())
  mk('保存', 'すべての案を 1 つの JSON ファイルに書き出す（Ctrl+S）', () => saveFile())
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
  // 開くの知らせは、その後にシーンが変わったら消す
  let noted: Scene | null = null
  const tellNow = show(note)
  const tell = (text: string, warn = false) => {
    noted = editor.scene()
    tellNow(text, warn)
  }
  const say = show(state)

  // ---- ファイル ----
  const saveFile = () => {
    const blob = new Blob([serializePlanSet(plans.current())], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = sceneFileName(new Date())
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  input.addEventListener('change', async () => {
    const f = input.files?.[0]
    input.value = ''
    if (!f) return
    // シーン 1 つだけの古いファイルは、ファイル名を案の名前にする
    const r = parsePlanFile(await f.text(), f.name.replace(/\.json$/i, ''))
    if (!r.ok) return tell(`${f.name} を開けません: ${r.error}`, true)
    if (plans.run({ type: 'importPlans', plans: r.plans })) {
      canvas.fitHome()
      tell(`${f.name} を開いた（案 ${r.plans.length} 件を足した）`)
    }
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
  // 最後に保存した（または復元した）ときのシーンと案の束の版。同じなら書かない
  let saved: { scene: Scene; rev: number } | null = null
  const unchanged = () => saved !== null && saved.scene === editor.scene() && saved.rev === plans.revision()
  let timer: ReturnType<typeof setTimeout> | undefined
  let ready = false // 復元が終わるまで保存しない（空のシーンで上書きしないため）

  const autosave = async () => {
    timer = undefined
    const scene = editor.scene()
    const rev = plans.revision()
    if (!db || unchanged()) return
    try {
      await request(db, 'readwrite', (s) => s.put(serializePlanSet(plans.current()), KEY))
      saved = { scene, rev }
      say(`自動保存 ${clock(new Date())}`)
    } catch (err) {
      say(`自動保存できません: ${errText(err)}。「保存」でファイルに書き出してください`, true)
    }
  }
  const schedule = () => {
    if (!ready || unchanged()) return
    clearTimeout(timer)
    timer = setTimeout(() => void autosave(), AUTOSAVE_DELAY_MS)
  }
  editor.onRender(() => {
    if (noted && editor.scene() !== noted) {
      noted = null
      tellNow('')
    }
    schedule()
  })
  plans.onChange(schedule)
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
      let text = await request<unknown>(db, 'readonly', (s) => s.get(KEY))
      if (text === undefined) text = await request<unknown>(db, 'readonly', (s) => s.get(OLD_KEY))
      if (typeof text === 'string') {
        const r = parsePlanFile(text, '案 1')
        if (r.ok) {
          // 起動前にもう何か操作していたら、そちらを優先する
          if (editor.scene().equipment.length === 0 && !editor.scene().background && plans.revision() === 0) {
            plans.load({ plans: r.plans, active: r.active })
            saved = { scene: editor.scene(), rev: plans.revision() }
            canvas.fitHome()
            tell(r.plans.length > 1 ? `前回の続きを開いた（案 ${r.plans.length} 件）` : '前回の続きを開いた')
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
