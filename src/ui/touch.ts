// スマホなど指で触る画面と、狭い画面のための部品。
// - 道具バーの先頭の「パネル」で左の欄（狭い画面では下の欄）を出し入れする
// - 指で触る画面では、キャンバスの下にキーの代わりのボタンを出す（R・Backspace・Enter・Delete・Esc）
// キーの代わりは、各部品が今受けているキーと同じ道を通すため、window にキーの出来事を送る。
import type { Canvas } from './canvas'
import type { Editor } from './editor'

// これより狭い画面では、欄をキャンバスの下に出し、最初は閉じておく（style.css の @media と同じ幅）
export const NARROW_QUERY = '(max-width: 760px)'

export function mountTouch(canvas: Canvas, editor: Editor): void {
  const root = canvas.svg.closest('.canvas-root')
  if (!(root instanceof HTMLElement)) return

  // ---- 欄の出し入れ ----
  const panelBtn = document.createElement('button')
  panelBtn.type = 'button'
  panelBtn.className = 'panel-toggle'
  const narrow = window.matchMedia?.(NARROW_QUERY).matches ?? false
  const setOpen = (open: boolean) => {
    root.classList.toggle('side-closed', !open)
    panelBtn.textContent = open ? 'パネルを隠す' : 'パネル'
    panelBtn.title = open ? '欄を隠して図面を広く見る' : '案・ひな形・選択中の設備などの欄を出す'
    panelBtn.setAttribute('aria-expanded', String(open))
  }
  setOpen(!narrow)
  panelBtn.addEventListener('click', () => {
    setOpen(root.classList.contains('side-closed'))
    panelBtn.blur()
  })
  canvas.toolbar.prepend(panelBtn)

  // ---- キーの代わりのボタン ----
  const bar = document.createElement('div')
  bar.className = 'touch-bar'
  const press = (key: string) => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  }
  const mk = (label: string, title: string, onClick: () => void) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = label
    b.title = title
    b.addEventListener('click', () => {
      onClick()
      b.blur()
    })
    bar.append(b)
    return b
  }
  const multiBtn = mk('複数選ぶ', '触った設備を選び足す・外す（Shift を押したままのクリックと同じ）', () =>
    editor.setMultiSelect(!editor.multiSelect()),
  )
  const delBtn = mk('消す', '選んでいる設備・通路の頂点・通路・つなぎを消す（Delete と同じ）', () => press('Delete'))
  const rotBtn = mk('回す', '置く設備を 90 度回す（R と同じ）', () => press('r'))
  const backBtn = mk('1 つ戻す', '最後に置いた点を取り消す（Backspace と同じ）', () => press('Backspace'))
  const doneBtn = mk('終える', '描いている外形・通路を終える（Enter と同じ）', () => press('Enter'))
  const quitBtn = mk('やめる', '今の操作をやめる（Esc と同じ）', () => press('Escape'))
  root.append(bar)

  const update = () => {
    const placing = canvas.svg.classList.contains('placing')
    const picking = canvas.svg.classList.contains('picking')
    const idle = !placing && !picking
    multiBtn.hidden = !idle
    multiBtn.classList.toggle('active', editor.multiSelect())
    multiBtn.setAttribute('aria-pressed', String(editor.multiSelect()))
    delBtn.hidden = !idle
    rotBtn.hidden = !placing
    backBtn.hidden = !picking
    doneBtn.hidden = !picking
    quitBtn.hidden = idle
  }
  editor.onRender(update)
  update()
}
