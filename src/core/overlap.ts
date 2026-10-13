// 重なりの検出: 設備どうし、設備と AGV の通路、設備の本体と他の設備の保守用の余白。DOM に触らない。
// 設備は回転を考えた外接の長方形（90 度刻みなので軸にそろう）で見る。辺や角が接するだけなら重なりとしない。
// 通路は画面の描き方（SVG の太線、角は miter、端は butt）と同じ形を、凸多角形の集まりにして扱う:
// 中心線の線分ごとの長方形と、角の外側を埋める多角形（miter の尖り。尖りすぎる角は SVG と同じく bevel に落とす）。

import { aisleSegments, type Aisle } from './aisle'
import { clearanceRect, footprint, worldClearance, type Equipment, type Scene } from './scene'
import type { Point, Rect } from './viewport'

// 接しているだけとみなす誤差（mm）
const EPS = 1e-6
// SVG の stroke-miterlimit の既定値。角の尖りの長さ ÷ 線の太さがこれを超えると bevel になる
const MITER_LIMIT = 4

export type Overlap =
  // 設備どうし。region は重なっている長方形
  | { kind: 'equipment'; a: string; b: string; region: Rect }
  // 設備と通路。regions は重なっている部分（凸多角形の集まり。互いに重なることがある）
  | { kind: 'aisle'; equipment: string; aisle: string; regions: Point[][] }
  // 設備 equipment の本体が、設備 owner の余白に入っている。regions は入っている部分（余白を辺ごとに分けた長方形との重なり）
  | { kind: 'clearance'; owner: string; equipment: string; regions: Rect[] }

// 2 つの長方形の内部が重なっているか（辺や角が接するだけなら重ならない）。重なっていればその長方形
export function rectOverlap(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  if (right - x <= EPS || bottom - y <= EPS) return null
  return { x, y, width: right - x, height: bottom - y }
}

const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y })
const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y })
const mul = (a: Point, k: number): Point => ({ x: a.x * k, y: a.y * k })
const unit = (a: Point): Point => mul(a, 1 / Math.hypot(a.x, a.y))
const normal = (u: Point): Point => ({ x: -u.y, y: u.x })

// 通路の帯を凸多角形の集まりにする。線分ごとの長方形と、角の外側の埋め
export function aislePieces(a: Aisle): Point[][] {
  const h = a.width / 2
  const segs = aisleSegments(a)
  const pieces: Point[][] = []
  for (const [p, q] of segs) {
    const o = mul(normal(unit(sub(q, p))), h)
    pieces.push([add(p, o), add(q, o), sub(q, o), sub(p, o)])
  }
  // 角: 開いた通路は途中の頂点、周回はすべての頂点
  const joins = a.closed ? segs.length : segs.length - 1
  for (let i = 0; i < joins; i++) {
    const [p, v] = segs[i]!
    const [, r] = segs[(i + 1) % segs.length]!
    const u = unit(sub(v, p))
    const w = unit(sub(r, v))
    const cross = u.x * w.y - u.y * w.x
    const dot = u.x * w.x + u.y * w.y
    // まっすぐ（埋めが要らない）か、折り返し（外側が決まらず、SVG でも尖りが出ない）
    if (Math.abs(cross) <= 1e-12) continue
    // 曲がる向きの反対側が外側
    const s = cross > 0 ? -1 : 1
    const p1 = add(v, mul(normal(u), s * h))
    const p2 = add(v, mul(normal(w), s * h))
    // 曲がる角度 α に対し、尖りの長さ ÷ 太さ = 1 / cos(α/2)
    const cosHalf = Math.sqrt((1 + dot) / 2)
    if (cosHalf > 0 && 1 / cosHalf <= MITER_LIMIT) {
      const tanHalf = Math.sqrt((1 - dot) / 2) / cosHalf
      pieces.push([v, p1, add(p1, mul(u, h * tanHalf)), p2])
    } else {
      pieces.push([v, p1, p2])
    }
  }
  return pieces
}

// 凸多角形と長方形の内部が重なっているか（分離軸。接するだけなら重ならない）
export function convexOverlapsRect(poly: readonly Point[], r: Rect): boolean {
  const corners: Point[] = [
    { x: r.x, y: r.y },
    { x: r.x + r.width, y: r.y },
    { x: r.x + r.width, y: r.y + r.height },
    { x: r.x, y: r.y + r.height },
  ]
  const axes: Point[] = [{ x: 1, y: 0 }, { x: 0, y: 1 }]
  for (let i = 0; i < poly.length; i++) {
    const e = sub(poly[(i + 1) % poly.length]!, poly[i]!)
    const len = Math.hypot(e.x, e.y)
    if (len > EPS) axes.push({ x: -e.y / len, y: e.x / len })
  }
  for (const ax of axes) {
    const proj = (pts: readonly Point[]) => {
      let lo = Infinity
      let hi = -Infinity
      for (const p of pts) {
        const d = p.x * ax.x + p.y * ax.y
        lo = Math.min(lo, d)
        hi = Math.max(hi, d)
      }
      return [lo, hi] as const
    }
    const [a0, a1] = proj(poly)
    const [b0, b1] = proj(corners)
    if (a1 <= b0 + EPS || b1 <= a0 + EPS) return false
  }
  return true
}

// 凸多角形を長方形で切り取る（Sutherland–Hodgman）。何も残らなければ空の配列
export function clipToRect(poly: readonly Point[], r: Rect): Point[] {
  type Edge = { inside: (p: Point) => boolean; cut: (a: Point, b: Point) => Point }
  const at = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
  const edges: Edge[] = [
    { inside: (p) => p.x >= r.x, cut: (a, b) => at(a, b, (r.x - a.x) / (b.x - a.x)) },
    { inside: (p) => p.x <= r.x + r.width, cut: (a, b) => at(a, b, (r.x + r.width - a.x) / (b.x - a.x)) },
    { inside: (p) => p.y >= r.y, cut: (a, b) => at(a, b, (r.y - a.y) / (b.y - a.y)) },
    { inside: (p) => p.y <= r.y + r.height, cut: (a, b) => at(a, b, (r.y + r.height - a.y) / (b.y - a.y)) },
  ]
  let out: Point[] = [...poly]
  for (const e of edges) {
    const src = out
    out = []
    for (let i = 0; i < src.length; i++) {
      const cur = src[i]!
      const prev = src[(i + src.length - 1) % src.length]!
      if (e.inside(cur)) {
        if (!e.inside(prev)) out.push(e.cut(prev, cur))
        out.push(cur)
      } else if (e.inside(prev)) out.push(e.cut(prev, cur))
    }
    if (out.length === 0) break
  }
  return out.length >= 3 ? out : []
}

// 設備の余白（本体を除いた周り）を、重ならない長方形に分ける: 上と下は余白の幅いっぱい、左と右は本体の高さだけ。幅 0 の辺は出さない
export function clearanceZone(eq: Equipment): Rect[] {
  const f = footprint(eq)
  const r = clearanceRect(eq)
  const c = worldClearance(eq)
  const out: Rect[] = [
    { x: r.x, y: r.y, width: r.width, height: c.top },
    { x: r.x, y: f.y + f.height, width: r.width, height: c.bottom },
    { x: r.x, y: f.y, width: c.left, height: f.height },
    { x: f.x + f.width, y: f.y, width: c.right, height: f.height },
  ]
  return out.filter((q) => q.width > EPS && q.height > EPS)
}

// シーンの中の重なりをすべて挙げる。設備どうしは配列の順に (a, b)、続いて設備と通路、続いて余白（余白の持ち主の順）
export function findOverlaps(scene: Scene): Overlap[] {
  const out: Overlap[] = []
  const fps = scene.equipment.map((eq) => ({ id: eq.id, r: footprint(eq) }))
  for (let i = 0; i < fps.length; i++)
    for (let j = i + 1; j < fps.length; j++) {
      const region = rectOverlap(fps[i]!.r, fps[j]!.r)
      if (region) out.push({ kind: 'equipment', a: fps[i]!.id, b: fps[j]!.id, region })
    }
  const aisles = scene.aisles.map((a) => ({ id: a.id, pieces: aislePieces(a) }))
  for (const { id, r } of fps)
    for (const a of aisles) {
      const hit = a.pieces.filter((p) => convexOverlapsRect(p, r))
      if (hit.length === 0) continue
      out.push({ kind: 'aisle', equipment: id, aisle: a.id, regions: hit.map((p) => clipToRect(p, r)).filter((p) => p.length > 0) })
    }
  // 余白どうし・余白と通路・余白と敷地の外は、まだ示さない（DECISIONS.md の「未決」）
  for (const owner of scene.equipment) {
    const zone = clearanceZone(owner)
    if (zone.length === 0) continue
    for (const { id, r } of fps) {
      if (id === owner.id) continue
      const regions = zone.map((z) => rectOverlap(z, r)).filter((q): q is Rect => q !== null)
      if (regions.length > 0) out.push({ kind: 'clearance', owner: owner.id, equipment: id, regions })
    }
  }
  return out
}

// 本体の重なり（設備どうし、設備と通路）にかかわる設備の id
export function overlappingEquipment(overlaps: readonly Overlap[]): Set<string> {
  const ids = new Set<string>()
  for (const o of overlaps) {
    if (o.kind === 'equipment') ids.add(o.a).add(o.b)
    else if (o.kind === 'aisle') ids.add(o.equipment)
  }
  return ids
}

// 余白への入り込みにかかわる設備の id（入っている設備と、余白の持ち主）
export function clearanceEquipment(overlaps: readonly Overlap[]): Set<string> {
  const ids = new Set<string>()
  for (const o of overlaps) if (o.kind === 'clearance') ids.add(o.owner).add(o.equipment)
  return ids
}
