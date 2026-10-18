// 道具バーの「マス目」と「既定に戻す」「既定にする」「初期設定」。マス目の大きさは canvas、スナップは editor が持つ。
// 既定はこのブラウザに覚えておき（localStorage）、開いたときもその値で始める。計算と読み書きの形は src/core/gridPrefs.ts。
import type { Canvas } from './canvas'
import type { Editor } from './editor'
import { FACTORY_GRID_PREFS, GRID_CELLS, formatGridPrefs, parseGridPrefs, type GridPrefs } from '../core/gridPrefs'
import { prefKeys } from '../core/prefs'
import { formatLength } from '../core/viewport'

const KEY = 'layout-studio:grid-default'

function loadDefault(): GridPrefs {
  try {
    return parseGridPrefs(localStorage.getItem(KEY))
  } catch {
    return FACTORY_GRID_PREFS
  }
}

export function mountGrid(canvas: Canvas, editor: Editor): void {
  const label = document.createElement('label')
  label.className = 'grid-label'
  label.textContent = 'マス目 '
  label.title = 'マス目 1 つの大きさ。自動は拡大縮小に合わせて変わり、かっこの中が今の大きさ。大きさを決めると、縮小して細かくなりすぎたときだけ 10 マスごとに間引いて引く'
  const select = document.createElement('select')
  for (const c of GRID_CELLS) select.append(new Option(c === 0 ? '自動' : formatLength(c), String(c)))
  label.append(select)

  const mkButton = (text: string, title: string, onClick: () => void) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = text
    b.title = title
    b.addEventListener('click', () => {
      onClick()
      b.blur()
    })
    return b
  }
  const apply = (p: GridPrefs) => {
    canvas.setGridCell(p.grid)
    select.value = String(p.grid)
    editor.setSnapStep(p.snap)
  }
  const flash = (b: HTMLButtonElement, text: string) => {
    const was = b.textContent
    b.textContent = text
    window.setTimeout(() => (b.textContent = was), 1200)
  }
  const reset = mkButton('既定に戻す', 'マス目とスナップを既定に戻す（「既定にする」で覚えた値。覚えていなければ自動・100 mm）', () => {
    apply(loadDefault())
    flash(reset, '戻した')
  })
  const save = mkButton('既定にする', '今のマス目とスナップを既定として、このブラウザに覚えておく（次に開いたときもこの値で始まる）', () => {
    const p = { grid: canvas.gridCell(), snap: editor.snapStep() }
    try {
      localStorage.setItem(KEY, formatGridPrefs(p))
      flash(save, '覚えた')
    } catch {
      flash(save, '覚えられない')
    }
  })
  // 覚えた設定（マス目・スナップの既定、表示、白黒、ユニットごと）を全部消して、アプリの初めの値で開き直す。
  // 図面と案（自動保存）は消さない。開き直す前の自動保存は pagehide で書き出される。
  // 確かめは、続けてもう一度押すこと（確かめの窓は、埋め込まれた画面では出ずに断られることがあるため）
  let armed: number | undefined
  const factory = mkButton('初期設定', 'このブラウザに覚えた設定（マス目・スナップの既定、表示、白黒、ユニットごと）を、アプリの初めの値に戻す。続けてもう一度押すと戻る。図面と案は消えない', () => {
    if (armed === undefined) {
      factory.textContent = 'もう一度押すと戻す'
      armed = window.setTimeout(() => {
        armed = undefined
        factory.textContent = '初期設定'
      }, 3000)
      return
    }
    window.clearTimeout(armed)
    armed = undefined
    try {
      const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i) ?? '')
      for (const k of prefKeys(keys)) localStorage.removeItem(k)
    } catch {
      flash(factory, '戻せない')
      return
    }
    location.reload()
  })
  select.addEventListener('change', () => {
    canvas.setGridCell(Number(select.value))
    select.blur()
  })

  // スナップの隣に置く
  const snap = canvas.toolbar.querySelector('.snap-label')
  if (snap) snap.after(label, reset, save, factory)
  else canvas.toolbar.append(label, reset, save, factory)
  // 自動のときは、今の細かさを選択の中に出す（例: 「自動（500 mm）」）。下の段にも出ているが、目に入りにくい
  const autoOption = select.options[0]!
  canvas.onGridStep((minor) => {
    const text = `自動（${formatLength(minor)}）`
    if (autoOption.text !== text) autoOption.text = text
  })
  apply(loadDefault())
}
