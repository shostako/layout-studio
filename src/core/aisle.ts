// AGV の通路: 幅を持つポリライン。確かめ、長さ、当たり判定。DOM に触らない。
// 頂点の列（mm）は通路の中心線。幅は中心線の両側に半分ずつ取る。closed なら最後の頂点と最初の頂点を結んで周回にする。

import type { Scene } from './scene'
import type { Point } from './viewport'

export type Aisle = {
  id: string
  name: string
  points: Point[] // 中心線の頂点
  width: number // 通路の幅（mm）
  closed: boolean // 周回（最後と最初の頂点を結ぶ）
}

// 新しく描く通路の幅の最初の値（mm）。架空の目安で、描く前にも描いた後にも変えられる
export const DEFAULT_AISLE_WIDTH = 1500

// 同じ点とみなす誤差（mm）
const EPS = 1e-6

// 通路として受け付けるか。理由つきで断る（null なら問題なし）。
// 頂点は 2 つ以上（周回は 3 つ以上）、同じ点が続かない、幅は正の数。自分と交わるのは受け付ける（通路は交差してよい）
export function checkAisle(a: Aisle): string | null {
  if (typeof a !== 'object' || a === null) return '通路の形ではありません'
  if (typeof a.id !== 'string' || !a.id) return '通路の id が空です'
  if (typeof a.name !== 'string' || !a.name.trim()) return `通路 ${a.id} の名前が空です`
  if (!(typeof a.width === 'number' && a.width > 0 && Number.isFinite(a.width))) return '通路の幅は正の数にしてください'
  if (typeof a.closed !== 'boolean') return `通路 ${a.id} の closed が真偽値ではありません`
  if (!Array.isArray(a.points)) return `通路 ${a.id} の頂点（points）がありません`
  const pts = a.points
  if (pts.length < 2) return '通路は 2 つ以上の頂点で描いてください'
  if (a.closed && pts.length < 3) return '周回の通路は 3 つ以上の頂点で描いてください'
  for (const p of pts)
    if (typeof p !== 'object' || p === null || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return '通路の頂点の座標が数ではありません'
  const n = a.closed ? pts.length : pts.length - 1
  for (let i = 0; i < n; i++) {
    const p = pts[i]!
    const q = pts[(i + 1) % pts.length]!
    if (Math.abs(p.x - q.x) <= EPS && Math.abs(p.y - q.y) <= EPS) return '通路に同じ点が続いています'
  }
  return null
}

// 中心線の線分（周回なら閉じる辺も含む）
export function aisleSegments(a: Aisle): [Point, Point][] {
  const pts = a.points
  const out: [Point, Point][] = []
  for (let i = 0; i + 1 < pts.length; i++) out.push([pts[i]!, pts[i + 1]!])
  if (a.closed && pts.length >= 3) out.push([pts[pts.length - 1]!, pts[0]!])
  return out
}

// 中心線の長さ（mm）
export function aisleLength(a: Aisle): number {
  return aisleSegments(a).reduce((s, [p, q]) => s + Math.hypot(q.x - p.x, q.y - p.y), 0)
}

// 点 p と線分 ab の距離
export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

// 点 p の下にある通路の id。中心線から幅の半分（と画面の都合で足す余裕 slack）以内なら当たり。
// 重なっていたら上に描かれている（配列の後ろの）ものを返す
export function aisleHitTest(scene: Scene, p: Point, slack = 0): string | null {
  for (let i = scene.aisles.length - 1; i >= 0; i--) {
    const a = scene.aisles[i]!
    if (aisleSegments(a).some(([s, t]) => distanceToSegment(p, s, t) <= a.width / 2 + slack)) return a.id
  }
  return null
}

// 頂点 i を p に動かした頂点の列
export function moveAisleVertex(points: readonly Point[], i: number, p: Point): Point[] {
  return points.map((q, j) => (j === i ? { x: p.x, y: p.y } : q))
}

// 線分 seg（aisleSegments の番号。周回の閉じる辺は最後の番号）の途中に p を足した頂点の列。足した頂点は seg + 1 番目になる
export function insertAisleVertex(points: readonly Point[], seg: number, p: Point): Point[] {
  return [...points.slice(0, seg + 1), { x: p.x, y: p.y }, ...points.slice(seg + 1)]
}

// 頂点 i を除いた頂点の列。頂点が足りなくなるかは、コマンド（checkAisle）が確かめる
export function removeAisleVertex(points: readonly Point[], i: number): Point[] {
  return points.filter((_, j) => j !== i)
}

// p から tol 以内にある頂点の番号（いちばん近いもの）。無ければ null
export function aisleVertexAt(a: Aisle, p: Point, tol: number): number | null {
  let best: number | null = null
  let bestD = tol
  for (const [i, q] of a.points.entries()) {
    const d = Math.hypot(q.x - p.x, q.y - p.y)
    if (d <= bestD) {
      best = i
      bestD = d
    }
  }
  return best
}

// 線分ごとの中点（頂点を足すときのつまみ）。番号は aisleSegments と同じ
export function aisleMidpoints(a: Aisle): Point[] {
  return aisleSegments(a).map(([p, q]) => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }))
}

// まだ使われていない通路の id（'aisle-1', 'aisle-2', ...）
export function nextAisleId(scene: Scene): string {
  let max = 0
  for (const a of scene.aisles) {
    const m = /^aisle-(\d+)$/.exec(a.id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `aisle-${max + 1}`
}

// 次の通路の名前（「通路 1」「通路 2」…。使われている番号の最大 + 1）
export function nextAisleName(scene: Scene): string {
  let max = 0
  for (const a of scene.aisles) {
    const m = /^通路 (\d+)$/.exec(a.name)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `通路 ${max + 1}`
}
