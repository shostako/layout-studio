// レイアウト: 基準の設備（射出成形の組では成形機）の並び。案はどれか 1 つのレイアウトに属する（DECISIONS.md 2026-10-14）。DOM に触らない。
// 並びの比べ方（DECISIONS.md「大きく動かす」の境目）:
// 1. 列の分かれ方: 列は設備を短い辺の向きに積んだ並び（例の「7 台 1 列」は横の成形機を上下に 7 台）。種類と向き（横・縦）ごとに、
//    横の設備は中心の x、縦の設備は中心の y を小さい順に並べ、隣どうしの差が COLUMN_GAP を超えたところで次の列にする。
// 2. 列ごとの中身: 列の中を積む向きの小さい順に並べた、1 台ずつの回転。
// 3. 列どうしの位置の関係: どの 2 列についても、x と y それぞれで中心の範囲が前・後・重なる（COLUMN_GAP 以内の差は重なる）のどれか。
// 3 つが同じなら同じ並び（列の中の間隔を詰めた・列を丸ごと寄せたは同じ）。

import { footprint, type Equipment, type Scene } from './scene'
import { findTemplate } from './templates'
import { isAnchor } from './unit'

type Rows = number[] // 列ごとの台数（列の並びの順）

// 同じ列とみなす中心の差（mm）。列どうしの範囲が「重なる」とみなす差にも使う。寸法に依らない決まった値
export const COLUMN_GAP = 1000

type Column = { kind: string; horizontal: boolean; items: Equipment[] } // items は積む向きの小さい順

const isHorizontal = (e: Equipment) => {
  const f = footprint(e)
  return f.width >= f.height
}

function columnsOf(items: Equipment[], kind: string, horizontal: boolean): Column[] {
  const key = (e: Equipment) => (horizontal ? e.x : e.y)
  const along = (e: Equipment) => (horizontal ? e.y : e.x)
  const sorted = [...items].sort((a, b) => key(a) - key(b))
  const out: Column[] = []
  let prev: Equipment | null = null
  for (const e of sorted) {
    if (prev && key(e) - key(prev) <= COLUMN_GAP) out[out.length - 1]!.items.push(e)
    else out.push({ kind, horizontal, items: [e] })
    prev = e
  }
  for (const c of out) c.items.sort((a, b) => along(a) - along(b))
  return out
}

function allColumns(scene: Scene): Column[] {
  const anchors = scene.equipment.filter((e) => isAnchor(scene, e))
  const kinds = [...new Set(anchors.map((e) => e.kind))].sort()
  return kinds.flatMap((kind) => {
    const list = anchors.filter((e) => e.kind === kind)
    return [...columnsOf(list.filter(isHorizontal), kind, true), ...columnsOf(list.filter((e) => !isHorizontal(e)), kind, false)]
  })
}

// 2 列の、ある軸での中心の範囲の関係。B＝a が前、A＝a が後、O＝重なる
function rangeRelation(a: Column, b: Column, k: 'x' | 'y'): string {
  const lo = (c: Column) => Math.min(...c.items.map((e) => e[k]))
  const hi = (c: Column) => Math.max(...c.items.map((e) => e[k]))
  if (hi(a) + COLUMN_GAP < lo(b)) return 'B'
  if (lo(a) > hi(b) + COLUMN_GAP) return 'A'
  return 'O'
}

// 並びを表す文字列。同じ文字列なら同じレイアウト。基準の設備が無ければ空文字列
export function layoutSignature(scene: Scene): string {
  const cols = allColumns(scene)
  if (cols.length === 0) return ''
  const parts = cols.map((c) => `${c.kind}/${c.horizontal ? 'H' : 'V'}:${c.items.map((e) => e.rotation).join(',')}`)
  const rel: string[] = []
  for (let i = 0; i < cols.length; i++)
    for (let j = i + 1; j < cols.length; j++) rel.push(rangeRelation(cols[i]!, cols[j]!, 'x') + rangeRelation(cols[i]!, cols[j]!, 'y'))
  return parts.join(' ') + (rel.length ? ` | ${rel.join(',')}` : '')
}

type Arrangement = { kind: string; name: string; h: Rows; v: Rows }[]

function arrangement(scene: Scene): Arrangement {
  const cols = allColumns(scene)
  const kinds = [...new Set(cols.map((c) => c.kind))]
  return kinds.map((kind) => ({
    kind,
    name: findTemplate(scene.templates, kind)?.name ?? kind,
    h: cols.filter((c) => c.kind === kind && c.horizontal).map((c) => c.items.length),
    v: cols.filter((c) => c.kind === kind && !c.horizontal).map((c) => c.items.length),
  }))
}

const sum = (r: Rows) => r.reduce((a, b) => a + b, 0)

// 並びの説明（例: 「成形機 7 台（横 1 列）」「成形機 14 台（横 2 列: 7・7）」「成形機 10 台（横 6・縦 4）」）
export function describeLayout(scene: Scene): string {
  const a = arrangement(scene)
  if (a.length === 0) return '基準の設備なし'
  return a
    .map(({ name, h, v }) => {
      const n = sum(h) + sum(v)
      const part = (label: string, r: Rows) => (r.length <= 1 ? `${label} 1 列` : `${label} ${r.length} 列: ${r.join('・')}`)
      const detail = h.length && v.length ? `横 ${sum(h)}・縦 ${sum(v)}` : h.length ? part('横', h) : part('縦', v)
      return `${name} ${n} 台（${detail}）`
    })
    .join('、')
}

// レイアウトの番号 L01, L02, ...
export function layoutNumber(n: number): string {
  return `L${String(n).padStart(2, '0')}`
}

export function nextLayoutId(used: Iterable<string>): string {
  let max = 0
  for (const id of used) {
    const m = /^L(\d+)$/.exec(id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return layoutNumber(max + 1)
}
