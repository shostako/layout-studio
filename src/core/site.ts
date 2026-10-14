// 敷地の外形（多角形）: 確かめ、面積、設備のはみ出しの判定。DOM に触らない。
// 外形は頂点の列（mm）で持ち、最後の頂点と最初の頂点を結んで閉じる。向き（時計回りか）は問わない。

import { backgroundRect } from './background'
import { equipmentBounds, footprint, type Scene } from './scene'
import type { Point, Rect } from './viewport'

export type Site = { points: Point[] }

// 頂点が辺の上に乗っているとみなす誤差（mm）。図面の寸法に比べて十分小さい
const EPS = 1e-6

// 符号つき面積（mm²）。y が下向きの座標で、画面の見た目が時計回りなら正
function signedArea(pts: readonly Point[]): number {
  let s = 0
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!
    const b = pts[(i + 1) % pts.length]!
    s += a.x * b.y - b.x * a.y
  }
  return s / 2
}

// 面積（mm²）
export function siteArea(site: Site): number {
  return Math.abs(signedArea(site.points))
}

// 外形を囲む長方形
export function siteBounds(site: Site): Rect {
  const xs = site.points.map((p) => p.x)
  const ys = site.points.map((p) => p.y)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }
}

// 左上 (x, y)、幅 width、奥行 depth の長方形の外形
export function rectSite(x: number, y: number, width: number, depth: number): Site {
  return {
    points: [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + depth },
      { x, y: y + depth },
    ],
  }
}

const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
const onSegment = (p: Point, a: Point, b: Point) =>
  Math.min(a.x, b.x) - EPS <= p.x && p.x <= Math.max(a.x, b.x) + EPS && Math.min(a.y, b.y) - EPS <= p.y && p.y <= Math.max(a.y, b.y) + EPS

// 線分 ab と cd が共有点を持つか（端点での接触も含む）
function segmentsTouch(a: Point, b: Point, c: Point, d: Point): boolean {
  const d1 = cross(c, d, a)
  const d2 = cross(c, d, b)
  const d3 = cross(a, b, c)
  const d4 = cross(a, b, d)
  if (((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) && ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS))) return true
  return (
    (Math.abs(d1) <= EPS && onSegment(a, c, d)) ||
    (Math.abs(d2) <= EPS && onSegment(b, c, d)) ||
    (Math.abs(d3) <= EPS && onSegment(c, a, b)) ||
    (Math.abs(d4) <= EPS && onSegment(d, a, b))
  )
}

// 外形として受け付けるか。理由つきで断る（null なら問題なし）。
// 頂点は 3 つ以上、同じ点が続かない、辺どうしが交わらない（隣の辺とは頂点だけを共有する）、面積が 0 でない
export function checkSite(site: Site): string | null {
  if (typeof site !== 'object' || site === null || !Array.isArray(site.points)) return '敷地の外形の頂点（points）がありません'
  const pts = site.points
  if (pts.length < 3) return '敷地の外形は 3 つ以上の頂点で描いてください'
  for (const p of pts)
    if (typeof p !== 'object' || p === null || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return '敷地の頂点の座標が数ではありません'
  const n = pts.length
  for (let i = 0; i < n; i++) {
    const a = pts[i]!
    const b = pts[(i + 1) % n]!
    if (Math.abs(a.x - b.x) <= EPS && Math.abs(a.y - b.y) <= EPS) return '敷地の外形に同じ点が続いています'
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const adjacent = j === i + 1 || (i === 0 && j === n - 1)
      const a = pts[i]!
      const b = pts[(i + 1) % n]!
      const c = pts[j]!
      const d = pts[(j + 1) % n]!
      if (adjacent) {
        // 隣の辺は共有する頂点だけで接する。折り返して重なっていたら断る
        const shared = j === i + 1 ? b : a
        const [p, q, r] = j === i + 1 ? [a, b, d] : [b, a, c]
        if (Math.abs(cross(shared, p, r)) <= EPS && (r.x - q.x) * (p.x - q.x) + (r.y - q.y) * (p.y - q.y) > 0)
          return '敷地の外形の辺が折り返して重なっています'
        continue
      }
      if (segmentsTouch(a, b, c, d)) return '敷地の外形の辺どうしが交わっています'
    }
  }
  if (siteArea(site) <= EPS) return '敷地の外形の面積が 0 です'
  return null
}

// 点 p が外形の内側（辺の上を含む）にあるか
export function pointInSite(site: Site, p: Point): boolean {
  const pts = site.points
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i]!
    const b = pts[j]!
    if (Math.abs(cross(a, b, p)) <= EPS && onSegment(p, a, b)) return true
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

// 線分 ab が長方形 r の内部（辺を除く）を通るか。
// 線分を長方形で切り取り（Liang–Barsky）、残った部分の中点が内部にあるかで決める。
// 凸な長方形の中の線分は、中点が辺の上なら全体がその辺の上にある
function segmentEntersRect(a: Point, b: Point, r: Rect): boolean {
  let t0 = 0
  let t1 = 1
  const dx = b.x - a.x
  const dy = b.y - a.y
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0
    const t = q / p
    if (p < 0) {
      if (t > t1) return false
      if (t > t0) t0 = t
    } else {
      if (t < t0) return false
      if (t < t1) t1 = t
    }
    return true
  }
  if (!clip(-dx, a.x - r.x) || !clip(dx, r.x + r.width - a.x) || !clip(-dy, a.y - r.y) || !clip(dy, r.y + r.height - a.y))
    return false
  const t = (t0 + t1) / 2
  const mx = a.x + dx * t
  const my = a.y + dy * t
  return mx > r.x + EPS && mx < r.x + r.width - EPS && my > r.y + EPS && my < r.y + r.height - EPS
}

// 長方形 r が外形の中に収まっているか（辺に接するのは収まっているとみなす）。
// 外形の辺が長方形の内部を通らなければ、内部は丸ごと外形の内か外のどちらかなので、中心で決まる
export function rectInSite(site: Site, r: Rect): boolean {
  const pts = site.points
  for (let i = 0; i < pts.length; i++) if (segmentEntersRect(pts[i]!, pts[(i + 1) % pts.length]!, r)) return false
  return pointInSite(site, { x: r.x + r.width / 2, y: r.y + r.height / 2 })
}

// 外形からはみ出している設備の id。外形が無ければ空
export function equipmentOutsideSite(scene: Scene): string[] {
  const site = scene.site
  if (!site) return []
  return scene.equipment.filter((eq) => !rectInSite(site, footprint(eq))).map((eq) => eq.id)
}

// 「全体」で見せる範囲: 背景・敷地・設備・通路をまとめて囲む長方形。どれも無ければ null
export function sceneExtent(scene: Scene): Rect | null {
  const rects: Rect[] = []
  if (scene.background) rects.push(backgroundRect(scene.background))
  if (scene.site) rects.push(siteBounds(scene.site))
  const eq = equipmentBounds(scene.equipment)
  if (eq) rects.push(eq)
  for (const a of scene.aisles) {
    if (a.points.length === 0) continue
    const half = a.width / 2
    const xs = a.points.map((p) => p.x)
    const ys = a.points.map((p) => p.y)
    const x = Math.min(...xs) - half
    const y = Math.min(...ys) - half
    rects.push({ x, y, width: Math.max(...xs) + half - x, height: Math.max(...ys) + half - y })
  }
  if (rects.length === 0) return null
  const x = Math.min(...rects.map((r) => r.x))
  const y = Math.min(...rects.map((r) => r.y))
  const right = Math.max(...rects.map((r) => r.x + r.width))
  const bottom = Math.max(...rects.map((r) => r.y + r.height))
  return { x, y, width: right - x, height: bottom - y }
}
