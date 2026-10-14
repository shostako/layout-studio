// 選択中の欄の「付帯設備を付ける」「整える」。計算は src/core/attach.ts で、結果のコマンドを editor.run に通す（元に戻す 1 回で戻る）。
// 付けるは選んだ基準の設備（成形機）に。整えるは選んだ基準の設備のユニットを、基準の設備を選んでいなければ全部のユニットを揃える。
import type { Canvas } from './canvas'
import type { Editor } from './editor'
import { applyCommand } from '../core/commands'
import { arrangeUnit, attachUnit, forAnchors, hasRecipe, type Side } from '../core/attach'
import { isAnchor } from '../core/unit'

const SIDE_OPTIONS: [Side | '', string][] = [
  ['', '自動'],
  ['top', '上'],
  ['bottom', '下'],
  ['left', '左'],
  ['right', '右'],
]

export function mountAttach(canvas: Canvas, editor: Editor): void {
  const box = document.createElement('div')
  box.className = 'attach-panel'
  const actions = document.createElement('div')
  actions.className = 'actions'
  const mkButton = (label: string, title: string, onClick: () => void) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = label
    b.title = title
    b.addEventListener('click', () => {
      onClick()
      b.blur()
    })
    actions.append(b)
    return b
  }
  const mkSelect = (label: string, title: string) => {
    const l = document.createElement('label')
    l.title = title
    const s = document.createElement('select')
    for (const [v, t] of SIDE_OPTIONS) s.append(new Option(t, v))
    l.append(label, s)
    return { label: l, select: s }
  }
  const attachBtn = mkButton('付帯設備を付ける', '選んだ基準の設備（成形機）に、決まりどおりの付帯設備（取出機・型抜き機・トリミング機・ストッカーと予備）を置いてつなぐ。ユニットにある設備は動かして使う', () => doAttach())
  const arrangeBtn = mkButton('整える', '付帯設備を、今の並びの順と向きのまま、余白ちょうどの間隔で列に揃える（成形機と取出機は動かさない）。成形機を選んでいなければ全部のユニット', () => doArrange())
  const side = mkSelect('取り出し側', '成形機の長い辺のどちらに成形品を落とすか。自動は、つないだ取出機・付帯設備の位置から（無ければ横は下、縦は右）')
  const toward = mkSelect('並べる向き', '後工程を長い辺に沿ってどちらへ並べるか。自動は、つないだ取出機と反対の側（無ければ横は左、縦は上）')
  const opts = document.createElement('div')
  opts.className = 'attach-options'
  opts.append(side.label, toward.label)
  const note = document.createElement('div')
  note.className = 'hint'
  box.append(actions, opts, note)

  // 選択中の欄の操作ボタンの下に置く
  const anchorRow = Array.from(canvas.side.querySelectorAll('.actions')).find((a) => a.textContent?.includes('複製'))
  if (anchorRow) anchorRow.after(box)
  else canvas.side.append(box)

  const selectedAnchors = () => {
    const s = editor.scene()
    return editor.selection().filter((id) => {
      const e = s.equipment.find((x) => x.id === id)
      return !!e && isAnchor(s, e)
    })
  }
  // 「全部を整える」の相手: 付帯設備の決まりがある基準の設備
  const allAnchors = () => editor.scene().equipment.filter((e) => isAnchor(editor.scene(), e) && hasRecipe(e)).map((e) => e.id)
  const apply = (r: ReturnType<typeof forAnchors>) => {
    if (!r.ok) {
      note.textContent = r.error
      return
    }
    note.textContent = r.notes.join('。')
    if (r.command) editor.run(r.command)
  }
  const step = (s: ReturnType<typeof editor.scene>, c: Parameters<typeof applyCommand>[1]) => {
    const a = applyCommand(s, c)
    return a.ok ? a.scene : a.error
  }
  function doAttach() {
    const ids = selectedAnchors()
    if (!ids.length) return
    const o = { side: (side.select.value || undefined) as Side | undefined, toward: (toward.select.value || undefined) as Side | undefined }
    apply(forAnchors(editor.scene(), ids, (s, id) => attachUnit(s, id, o), step))
  }
  function doArrange() {
    const ids = selectedAnchors()
    const targets = ids.length ? ids : allAnchors()
    if (!targets.length) return
    apply(forAnchors(editor.scene(), targets, (s, id) => arrangeUnit(s, id), step))
  }

  let last = ''
  const update = () => {
    const anchors = selectedAnchors()
    attachBtn.disabled = anchors.length === 0
    arrangeBtn.disabled = anchors.length === 0 && allAnchors().length === 0
    arrangeBtn.textContent = anchors.length ? '整える' : '全部を整える'
    // 選び直したら前の知らせを消す
    const key = editor.selection().join()
    if (key !== last) {
      last = key
      note.textContent = ''
    }
  }
  editor.onRender(update)
  update()
}
