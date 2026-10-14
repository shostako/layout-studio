// ひな形の下の「ユニットを並べる」: 基準の設備（成形機）を台数・列・向き・取り出し側を決めて、付帯設備つきでまとめて置く。
// 計算は src/core/block.ts。結果のコマンドを editor.run に通し（元に戻す 1 回で戻る）、置いた基準の設備を選ぶ（続けてユニットごと動かせる）。
import type { Canvas } from './canvas'
import type { Editor } from './editor'
import type { Side } from '../core/attach'
import { MAX_BLOCK, placeBlock } from '../core/block'

export function mountBlock(canvas: Canvas, editor: Editor): void {
  const panel = document.createElement('details')
  panel.className = 'kind-panel block-panel'
  const summary = document.createElement('summary')
  summary.textContent = 'ユニットを並べる'
  summary.title = '成形機を付帯設備つきで、台数・列・向きを決めてまとめて置く（縦横の混在は何度か並べて作る）'
  const props = document.createElement('div')
  props.className = 'props'
  const mkRow = (label: string, input: HTMLElement, title = '') => {
    const l = document.createElement('label')
    l.append(label, input)
    if (title) l.title = title
    props.append(l)
  }
  const num = (value: number, max: number) => {
    const i = document.createElement('input')
    i.type = 'number'
    i.min = '1'
    i.max = String(max)
    i.step = '1'
    i.value = String(value)
    return i
  }
  const sel = (options: [string, string][]) => {
    const s = document.createElement('select')
    for (const [v, t] of options) s.append(new Option(t, v))
    return s
  }
  const count = num(7, MAX_BLOCK)
  const columns = num(1, MAX_BLOCK)
  const orientation = sel([
    ['horizontal', '横（長い辺が左右）'],
    ['vertical', '縦（長い辺が上下）'],
  ])
  const sides: [string, string][] = [
    ['', '自動'],
    ['top', '上'],
    ['bottom', '下'],
    ['left', '左'],
    ['right', '右'],
  ]
  const side = sel(sides)
  const toward = sel(sides)
  mkRow('台数', count)
  mkRow('列', columns, '列は成形機を短い辺の向きに積んだ並び（横なら上下に積む）。台数を列に分ける')
  mkRow('向き', orientation)
  mkRow('取り出し側', side, '成形機の長い辺のどちらに成形品を落とすか。自動は横なら下、縦なら右')
  mkRow('並べる向き', toward, '後工程を長い辺に沿ってどちらへ並べるか。自動は横なら左、縦なら上')
  const actions = document.createElement('div')
  actions.className = 'actions'
  const go = document.createElement('button')
  go.type = 'button'
  go.textContent = '並べる'
  go.title = '置いてある設備の右（何も無ければ敷地の左上）に並べる。並べた成形機を選ぶので、そのままドラッグで動かせる'
  actions.append(go)
  const note = document.createElement('div')
  note.className = 'hint'
  panel.append(summary, props, actions, note)

  const after = canvas.side.querySelector('.kind-panel')
  if (after) after.after(panel)
  else canvas.side.append(panel)

  go.addEventListener('click', () => {
    go.blur()
    const r = placeBlock(editor.scene(), {
      count: Number(count.value),
      columns: Number(columns.value),
      orientation: orientation.value as 'horizontal' | 'vertical',
      side: (side.value || undefined) as Side | undefined,
      toward: (toward.value || undefined) as Side | undefined,
    })
    if (!r.ok) {
      note.textContent = r.error
      return
    }
    if (editor.run(r.command)) {
      editor.select(r.anchors)
      note.textContent = `${r.note}。並べた成形機を選んでいる（見えなければ道具バーの「全体」）`
    }
  })
}
