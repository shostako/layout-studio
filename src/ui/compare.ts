// 案を比べる表: 案ごとの敷地の面積、外接（設備・余白・通路を囲む長方形）、設備の本体と余白の床面積、台数、注意の件数。
// 数字は src/core/compare.ts の planMetrics で出す。表は画面の状態で、シーンにも履歴にも入れない。行のクリックでその案を開く。
import type { Canvas } from './canvas'
import type { Editor } from './editor'
import type { Plans } from './plans'
import { planMetrics, smallestIndexes, type PlanMetrics } from '../core/compare'
import { formatLength } from '../core/viewport'
import type { Scene } from '../core/scene'

// 1 坪 = 400/121 m²
const M2_PER_TSUBO = 400 / 121
const num = (v: number) => v.toLocaleString('ja-JP', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
const m2 = (mm2: number) => num(mm2 / 1e6)

export function mountCompare(canvas: Canvas, editor: Editor, plans: Plans): void {
  const panel = document.createElement('div')
  panel.className = 'compare-panel'
  panel.hidden = true
  const head = document.createElement('div')
  head.className = 'compare-head'
  const title = document.createElement('strong')
  title.textContent = '案の比べ'
  const close = document.createElement('button')
  close.type = 'button'
  close.textContent = '×'
  close.title = '閉じる'
  head.append(title, close)
  const table = document.createElement('table')
  const note = document.createElement('div')
  note.className = 'hint'
  note.textContent =
    '面積は m²。外接は設備（余白まで）と通路の帯を囲む長方形。余白は重なった所を 1 回だけ数え、他の設備の本体が入った所は本体に数える。太字は敷地・外接・余白の各列でいちばん小さい案（注意のある案は除く）。行のクリックでその案を開く'
  panel.append(head, table, note)
  canvas.svg.parentElement!.append(panel)

  // 「案」の欄の操作の並びに「比べる」を足す
  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.textContent = '比べる'
  toggle.title = '案ごとの面積と余白を表で並べる'
  const row = canvas.side.querySelector('.plan-panel .actions')
  if (row) row.append(toggle)
  else canvas.side.append(toggle)

  let open = false
  const show = (on: boolean) => {
    open = on
    panel.hidden = !on
    toggle.classList.toggle('active', on)
    if (on) draw()
  }
  toggle.addEventListener('click', () => show(!open))
  close.addEventListener('click', () => show(false))

  // シーンは書き換えずに作り直すので、同じシーンなら数字も同じ。ドラッグ中も開いている案の分だけ計算し直す
  const cache = new WeakMap<Scene, PlanMetrics>()
  const metrics = (s: Scene) => {
    let m = cache.get(s)
    if (!m) cache.set(s, (m = planMetrics(s)))
    return m
  }

  const cols: { label: string; title: string; value: (m: PlanMetrics) => number | null; text: (m: PlanMetrics) => string }[] = [
    {
      label: '敷地',
      title: '描いた敷地の外形の面積（m²）',
      value: (m) => m.siteArea,
      text: (m) => (m.siteArea === null ? '—' : m2(m.siteArea)),
    },
    {
      label: '外接',
      title: '設備（余白まで）と通路の帯をまとめて囲む長方形の面積（m²）と寸法',
      value: (m) => (m.extent ? m.extent.width * m.extent.height : null),
      text: (m) => (m.extent ? m2(m.extent.width * m.extent.height) : '—'),
    },
    { label: '本体', title: '設備の本体の床面積（m²、重なりは 1 回）', value: (m) => m.bodyArea, text: (m) => m2(m.bodyArea) },
    { label: '余白', title: '保守用の余白の床面積（m²、重なりは 1 回）', value: (m) => m.clearanceArea, text: (m) => m2(m.clearanceArea) },
  ]

  function draw() {
    if (!open) return
    const set = plans.current()
    const ms = set.plans.map((p) => metrics(p.id === set.active ? editor.shown() : p.scene))
    // 注意（重なり・入り込み・はみ出し）のある案は、詰まって見えても成り立たないので印の対象から外す。本体は設備が同じなら同じなので印を付けない
    const sound = ms.map((m) => m.overlaps + m.intrusions + m.outside === 0)
    const best = cols.map((c) =>
      c.label === '本体' ? new Set<number>() : new Set(smallestIndexes(ms.map((m, i) => (sound[i] ? c.value(m) : null)))),
    )
    const tr = (cells: HTMLElement[]) => {
      const r = document.createElement('tr')
      r.append(...cells)
      return r
    }
    const cell = (tag: 'th' | 'td', text: string, title = '', cls = '') => {
      const c = document.createElement(tag)
      c.textContent = text
      if (title) c.title = title
      if (cls) c.className = cls
      return c
    }
    const header = tr([
      cell('th', '案'),
      ...cols.map((c) => cell('th', c.label, c.title, 'num')),
      cell('th', '台数', '設備の台数', 'num'),
      cell('th', '注意', '本体の重なり・余白への入り込み・敷地からのはみ出しの件数', 'num'),
    ])
    const rows = set.plans.map((p, i) => {
      const m = ms[i]!
      const issues = m.overlaps + m.intrusions + m.outside
      const extentTitle = m.extent
        ? `${formatLength(Math.round(m.extent.width))} × ${formatLength(Math.round(m.extent.height))}`
        : ''
      const siteTitle = m.siteArea === null ? '敷地なし' : `${num(m.siteArea / 1e6 / M2_PER_TSUBO)} 坪`
      const r = tr([
        cell('td', p.name),
        ...cols.map((c, k) =>
          cell('td', c.text(m), k === 0 ? siteTitle : k === 1 ? extentTitle : '', `num${best[k]!.has(i) ? ' best' : ''}`),
        ),
        cell('td', String(m.equipmentCount), '', 'num'),
        cell(
          'td',
          issues ? String(issues) : '0',
          `重なり ${m.overlaps}、余白への入り込み ${m.intrusions}、はみ出し ${m.outside}`,
          `num${issues ? ' warn' : ''}`,
        ),
      ])
      r.className = p.id === set.active ? 'active' : ''
      r.title = p.id === set.active ? '開いている案' : `案「${p.name}」を開く`
      r.addEventListener('click', () => {
        if (p.id !== plans.current().active) plans.run({ type: 'switchPlan', id: p.id })
      })
      return r
    })
    table.replaceChildren(header, ...rows)
  }

  editor.onRender(draw)
  plans.onChange(draw)
}
