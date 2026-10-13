// AGV の道: 通路の中心線をつないだ網と、いちばん短い道。DOM に触らない。
// 通路はふつう両方向に走れる。一方通行（oneWay）の通路は頂点の順にだけ走る（DECISIONS.md）。中心線の頂点と、中心線どうしが交わる点・接する点を節にし、
// 節のあいだを中心線に沿って走る。網の外の点（AGV の出入り口、ストッカー）は、いちばん近い中心線の上の点で網に乗せる。

import { aisleSegments, type Aisle } from './aisle'
import type { Point } from './viewport'

export type RouteNet = {
  nodes: Point[]
  adj: { to: number; w: number }[][]
}

// 同じ節とみなす誤差（mm）
const EPS = 1e-6
const keyOf = (p: Point) => `${Math.round(p.x * 100)},${Math.round(p.y * 100)}`

// 点 p を線分 ab に下ろした点の位置（0〜1）と、その点
export function projectOnSegment(p: Point, a: Point, b: Point): { t: number; at: Point; d: number } {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
  const at = { x: a.x + t * dx, y: a.y + t * dy }
  return { t, at, d: Math.hypot(p.x - at.x, p.y - at.y) }
}

// 線分 ab と cd が交わる・接する所の、ab の上での位置（0〜1）の列。重なって並ぶ（同じ直線の上）なら、c・d が ab の上にあるときの位置
function crossings(a: Point, b: Point, c: Point, d: Point): number[] {
  const rx = b.x - a.x, ry = b.y - a.y
  const sx = d.x - c.x, sy = d.y - c.y
  const den = rx * sy - ry * sx
  const len = Math.hypot(rx, ry)
  if (len === 0) return []
  if (Math.abs(den) <= EPS * len * Math.hypot(sx, sy)) {
    // 平行。同じ直線の上なら、c・d のうち ab の上にあるもの
    const out: number[] = []
    for (const p of [c, d]) {
      const pr = projectOnSegment(p, a, b)
      if (pr.d <= 1e-3 && ((p.x - a.x) * rx + (p.y - a.y) * ry) / (len * len) >= -EPS) out.push(pr.t)
    }
    return out
  }
  const qx = c.x - a.x, qy = c.y - a.y
  const t = (qx * sy - qy * sx) / den
  const u = (qx * ry - qy * rx) / den
  const tol = 1e-9
  if (t < -tol || t > 1 + tol || u < -tol || u > 1 + tol) return []
  return [Math.max(0, Math.min(1, t))]
}

// 通路の網を作る。extra の点はそれぞれ、いちばん近い中心線の上の点で網に乗せ、その節の番号を attach に返す（通路が無ければ null）
export function buildRouteNet(aisles: readonly Aisle[], extra: readonly Point[] = []): { net: RouteNet; attach: (number | null)[] } {
  const segs = aisles.flatMap((a) => aisleSegments(a))
  const oneWay = aisles.flatMap((a) => aisleSegments(a).map(() => a.oneWay === true))
  const params: number[][] = segs.map(() => [0, 1])
  for (let i = 0; i < segs.length; i++)
    for (let j = 0; j < segs.length; j++) {
      if (i === j) continue
      const [a, b] = segs[i]!
      const [c, d] = segs[j]!
      params[i]!.push(...crossings(a, b, c, d))
    }
  // 網の外の点を、いちばん近い線分に下ろす
  const attachPoints: (Point | null)[] = extra.map((p) => {
    let best: { i: number; t: number; at: Point; d: number } | null = null
    for (const [i, [a, b]] of segs.entries()) {
      const pr = projectOnSegment(p, a, b)
      if (!best || pr.d < best.d - EPS) best = { i, ...pr }
    }
    if (!best) return null
    params[best.i]!.push(best.t)
    return best.at
  })

  const nodes: Point[] = []
  const index = new Map<string, number>()
  const nodeAt = (p: Point) => {
    const k = keyOf(p)
    let n = index.get(k)
    if (n === undefined) {
      n = nodes.length
      nodes.push({ x: p.x, y: p.y })
      index.set(k, n)
    }
    return n
  }
  const adj: { to: number; w: number }[][] = []
  // u から v へ。一方通行でなければ v から u へも
  const edge = (u: number, v: number, w: number, single: boolean) => {
    while (adj.length <= Math.max(u, v)) adj.push([])
    adj[u]!.push({ to: v, w })
    if (!single) adj[v]!.push({ to: u, w })
  }
  for (const [i, [a, b]] of segs.entries()) {
    const ts = [...new Set(params[i]!)].sort((x, y) => x - y)
    let prev: number | null = null
    let prevP: Point | null = null
    for (const t of ts) {
      const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
      const n = nodeAt(p)
      if (prev !== null && prevP && n !== prev) edge(prev, n, Math.hypot(p.x - prevP.x, p.y - prevP.y), oneWay[i]!)
      prev = n
      prevP = p
    }
  }
  while (adj.length < nodes.length) adj.push([])
  return { net: { nodes, adj }, attach: attachPoints.map((p) => (p ? index.get(keyOf(p))! : null)) }
}

// 節 from から節 to へのいちばん短い道（通る点の列）。つながっていなければ null
export function shortestPath(net: RouteNet, from: number, to: number): Point[] | null {
  const n = net.nodes.length
  const dist = new Array<number>(n).fill(Infinity)
  const prev = new Array<number>(n).fill(-1)
  const done = new Array<boolean>(n).fill(false)
  dist[from] = 0
  for (;;) {
    let u = -1
    for (let i = 0; i < n; i++) if (!done[i] && dist[i]! < Infinity && (u < 0 || dist[i]! < dist[u]!)) u = i
    if (u < 0) return null
    if (u === to) break
    done[u] = true
    for (const { to: v, w } of net.adj[u]!)
      if (dist[u]! + w < dist[v]!) {
        dist[v] = dist[u]! + w
        prev[v] = u
      }
  }
  const path: Point[] = []
  for (let v = to; v >= 0; v = prev[v]!) path.unshift(net.nodes[v]!)
  return path
}

// 点の列の長さ
export function pathLength(path: readonly Point[]): number {
  let s = 0
  for (let i = 1; i < path.length; i++) s += Math.hypot(path[i]!.x - path[i - 1]!.x, path[i]!.y - path[i - 1]!.y)
  return s
}

// 点の列を始めから s（mm）進んだ点と、進む向き（ラジアン、x 軸から y 軸へ）
export function pointAlong(path: readonly Point[], s: number): { at: Point; angle: number } {
  if (path.length === 0) return { at: { x: 0, y: 0 }, angle: 0 }
  let left = Math.max(0, s)
  let angle = 0
  for (let i = 1; i < path.length; i++) {
    const p = path[i - 1]!
    const q = path[i]!
    const len = Math.hypot(q.x - p.x, q.y - p.y)
    if (len === 0) continue
    angle = Math.atan2(q.y - p.y, q.x - p.x)
    if (left <= len) return { at: { x: p.x + ((q.x - p.x) * left) / len, y: p.y + ((q.y - p.y) * left) / len }, angle }
    left -= len
  }
  const last = path[path.length - 1]!
  return { at: { x: last.x, y: last.y }, angle }
}
