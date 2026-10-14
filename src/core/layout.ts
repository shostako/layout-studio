// レイアウト: 基準の設備（射出成形の組では成形機）の並び。案はどれか 1 つのレイアウトに属する（DECISIONS.md 2026-10-14）。DOM に触らない。
// 並びは、基準の設備の種類ごとに、向き（横・縦）ごとの列と、列ごとの台数で表す（signature）。
// 列は、設備を短い辺の向きに積んだ並び（例の「7 台 1 列」は横の成形機を上下に 7 台）。横の設備は中心の x、縦の設備は中心の y を
// 小さい順に並べ、隣どうしの差が短い辺の半分（両方の小さい方）を超えたところで次の列にする。
// 台数・向き・列の分かれ方が同じなら同じ並び（間隔を詰めた・列ごと寄せたは同じ）。

import { footprint, type Equipment, type Scene } from './scene'
import { findTemplate } from './templates'
import { isAnchor } from './unit'

type Rows = number[] // 列ごとの台数（列の並びの順）

function rows(items: Equipment[], horizontal: boolean): Rows {
  const key = (e: Equipment) => (horizontal ? e.x : e.y)
  const short = (e: Equipment) => {
    const f = footprint(e)
    return Math.min(f.width, f.height)
  }
  const sorted = [...items].sort((a, b) => key(a) - key(b))
  const out: Rows = []
  let prev: Equipment | null = null
  for (const e of sorted) {
    if (prev && key(e) - key(prev) <= Math.min(short(e), short(prev)) / 2) out[out.length - 1]! += 1
    else out.push(1)
    prev = e
  }
  return out
}

type Arrangement = { kind: string; name: string; h: Rows; v: Rows }[]

function arrangement(scene: Scene): Arrangement {
  const anchors = scene.equipment.filter((e) => isAnchor(scene, e))
  const kinds = [...new Set(anchors.map((e) => e.kind))].sort()
  return kinds.map((kind) => {
    const list = anchors.filter((e) => e.kind === kind)
    const horizontal = (e: Equipment) => {
      const f = footprint(e)
      return f.width >= f.height
    }
    return {
      kind,
      name: findTemplate(scene.templates, kind)?.name ?? kind,
      h: rows(list.filter(horizontal), true),
      v: rows(list.filter((e) => !horizontal(e)), false),
    }
  })
}

// 並びを表す文字列。同じ文字列なら同じレイアウト。基準の設備が無ければ空文字列
export function layoutSignature(scene: Scene): string {
  return arrangement(scene)
    .map((a) => `${a.kind}:H${a.h.join(',')};V${a.v.join(',')}`)
    .join('|')
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
