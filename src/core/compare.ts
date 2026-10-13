// 案を比べる数字: 敷地の面積、設備・余白・通路をまとめて囲む長方形（外接）、設備の本体と余白の床面積。DOM に触らない。
// 余白は重なった所を 1 回だけ数える（和集合）。他の設備の本体が入っている所は本体に数え、余白には数えない。

import { aisleLength } from './aisle'
import { aislePieces, findOverlaps } from './overlap'
import { clearanceRect, footprint, type Scene } from './scene'
import { equipmentOutsideSite, siteArea } from './site'
import type { Rect } from './viewport'

export type PlanMetrics = {
  siteArea: number | null // 敷地の外形の面積（mm²）。敷地が無ければ null
  extent: Rect | null // 設備（余白まで）と通路の帯をまとめて囲む長方形。どちらも無ければ null
  bodyArea: number // 設備の本体の床面積（mm²、重なりは 1 回）
  clearanceArea: number // 余白の床面積（mm²、重なりは 1 回。本体の分は除く）
  equipmentCount: number
  aisleLength: number // 通路の中心線の計（mm）
  overlaps: number // 本体の重なり（設備どうし、設備と通路）の件数
  intrusions: number // 他の設備の余白に本体が入っている件数
  outside: number // 敷地からはみ出した設備の台数
}

// 軸にそろった長方形の和集合の面積。x の切れ目ごとの帯で、y の区間の和を足す（n 個で O(n² log n)。設備が数十台なら十分速い）
export function rectUnionArea(rects: readonly Rect[]): number {
  const rs = rects.filter((r) => r.width > 0 && r.height > 0)
  const xs = [...new Set(rs.flatMap((r) => [r.x, r.x + r.width]))].sort((a, b) => a - b)
  let area = 0
  for (let i = 0; i + 1 < xs.length; i++) {
    const x0 = xs[i]!
    const x1 = xs[i + 1]!
    const spans = rs
      .filter((r) => r.x <= x0 && r.x + r.width >= x1)
      .map((r) => [r.y, r.y + r.height] as const)
      .sort((a, b) => a[0] - b[0])
    let covered = 0
    let end = -Infinity
    for (const [y0, y1] of spans) {
      if (y1 <= end) continue
      covered += y1 - Math.max(y0, end)
      end = y1
    }
    area += covered * (x1 - x0)
  }
  return area
}

function boundsOf(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null
  const x = Math.min(...rects.map((r) => r.x))
  const y = Math.min(...rects.map((r) => r.y))
  const right = Math.max(...rects.map((r) => r.x + r.width))
  const bottom = Math.max(...rects.map((r) => r.y + r.height))
  return { x, y, width: right - x, height: bottom - y }
}

// 通路の帯（画面に描いている形、角の埋めも含む）を囲む長方形
function aisleBounds(scene: Scene): Rect[] {
  return scene.aisles.flatMap((a) => {
    const pts = aislePieces(a).flat()
    if (pts.length === 0) return []
    const xs = pts.map((p) => p.x)
    const ys = pts.map((p) => p.y)
    const x = Math.min(...xs)
    const y = Math.min(...ys)
    return [{ x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }]
  })
}

export function planMetrics(scene: Scene): PlanMetrics {
  const bodies = scene.equipment.map(footprint)
  const withClearance = scene.equipment.map(clearanceRect)
  const bodyArea = rectUnionArea(bodies)
  // 本体と余白を合わせた和集合から本体の和集合を引く（余白どうしの重なりも、余白に入った本体も 1 回だけ）
  const clearanceArea = Math.max(0, rectUnionArea([...bodies, ...withClearance]) - bodyArea)
  const overlaps = findOverlaps(scene)
  return {
    siteArea: scene.site ? siteArea(scene.site) : null,
    extent: boundsOf([...withClearance, ...aisleBounds(scene)]),
    bodyArea,
    clearanceArea,
    equipmentCount: scene.equipment.length,
    aisleLength: scene.aisles.reduce((s, a) => s + aisleLength(a), 0),
    overlaps: overlaps.filter((o) => o.kind !== 'clearance').length,
    intrusions: overlaps.filter((o) => o.kind === 'clearance').length,
    outside: equipmentOutsideSite(scene).length,
  }
}

// 列の中でいちばん小さい値の番号（null は除く。同じ値が並べば全部）。表で最も詰まった案に印を付けるのに使う
export function smallestIndexes(values: readonly (number | null)[]): number[] {
  const nums = values.filter((v): v is number => v !== null)
  if (nums.length < 2) return []
  const min = Math.min(...nums)
  return values.flatMap((v, i) => (v !== null && Math.abs(v - min) < 1e-6 ? [i] : []))
}
