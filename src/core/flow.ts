// 工程のつなぎ: 設備から設備へ、ものが流れる向きを持つ矢印。確かめ、工程の順に並べてつなぐ、描く線、当たり判定。DOM に触らない。
// つなぎは向きのある辺（from → to）で、設備の id の組で見分ける。1 台から何台へも、何台からも 1 台へもつなげる
// （成形機ごとに列を持つ案も、列を共有する案も、予備のストッカーへの枝も書ける）。輪（元の設備へ戻る流れ）は作れない。

import { distanceToSegment } from './aisle'
import { footprint, type Equipment, type Scene } from './scene'
import { TEMPLATES } from './templates'
import type { Point } from './viewport'

export type Link = { from: string; to: string }

export const sameLink = (a: Link, b: Link) => a.from === b.from && a.to === b.to

// from から矢印をたどって to へ行けるか
export function reaches(links: readonly Link[], from: string, to: string): boolean {
  const seen = new Set<string>()
  const stack = [from]
  while (stack.length) {
    const id = stack.pop()!
    if (id === to) return true
    if (seen.has(id)) continue
    seen.add(id)
    for (const l of links) if (l.from === id) stack.push(l.to)
  }
  return false
}

// scene にこのつなぎを足せるか。理由つきで断る（null なら問題なし）
export function checkLink(scene: Scene, link: Link): string | null {
  if (typeof link !== 'object' || link === null) return 'つなぎの形ではありません'
  const { from, to } = link
  if (typeof from !== 'string' || typeof to !== 'string') return 'つなぎの from・to が設備の id ではありません'
  const name = (id: string) => scene.equipment.find((e) => e.id === id)?.name
  const a = name(from)
  const b = name(to)
  if (a === undefined) return `つなぐ設備が見つかりません: ${from}`
  if (b === undefined) return `つなぐ設備が見つかりません: ${to}`
  if (from === to) return '設備を自分自身にはつなげません'
  if (scene.links.some((l) => sameLink(l, link))) return `${a} → ${b} はもうつないであります`
  if (reaches(scene.links, to, from)) return `${a} → ${b} をつなぐと流れが輪になります`
  return null
}

// 工程の順（ひな形の並び）での位置。ひな形に無い種類は -1
export function processIndex(kind: string): number {
  return TEMPLATES.findIndex((t) => t.kind === kind)
}

export type ChainResult = { ok: true; links: Link[] } | { ok: false; error: string }

// 選んだ設備を工程の順（成形機 → 取出機 → … → 台車ストッカー）に並べ、隣どうしをつなぐ。
// 同じ種類が 2 台以上あると順が決まらないので断る。もうつないである組は返さない
export function chainByProcess(scene: Scene, ids: readonly string[]): ChainResult {
  const items = ids.map((id) => scene.equipment.find((e) => e.id === id)).filter((e): e is Equipment => !!e)
  if (items.length < 2) return { ok: false, error: '工程の順につなぐには、設備を 2 台以上選んでください' }
  const unknown = items.filter((e) => processIndex(e.kind) < 0)
  if (unknown.length) return { ok: false, error: `工程の順が決まっていない設備があります: ${unknown.map((e) => e.name).join('、')}` }
  const sorted = [...items].sort((a, b) => processIndex(a.kind) - processIndex(b.kind))
  for (let i = 1; i < sorted.length; i++)
    if (sorted[i]!.kind === sorted[i - 1]!.kind)
      return { ok: false, error: `同じ種類が 2 台あり、順が決まりません: ${sorted[i - 1]!.name}、${sorted[i]!.name}。1 列ずつ選ぶか、「つなぐ」で 1 本ずつつないでください` }
  const links: Link[] = []
  for (let i = 1; i < sorted.length; i++) {
    const link = { from: sorted[i - 1]!.id, to: sorted[i]!.id }
    if (!scene.links.some((l) => sameLink(l, link))) links.push(link)
  }
  if (links.length === 0) return { ok: false, error: '選んだ設備はもう工程の順につないであります' }
  return { ok: true, links }
}

// 中心 c から向き d へ進んで、長方形 r の縁に出る点までの長さ（c は r の中）
function exitDistance(r: { x: number; y: number; width: number; height: number }, c: Point, d: Point): number {
  let t = Infinity
  if (d.x > 0) t = Math.min(t, (r.x + r.width - c.x) / d.x)
  if (d.x < 0) t = Math.min(t, (r.x - c.x) / d.x)
  if (d.y > 0) t = Math.min(t, (r.y + r.height - c.y) / d.y)
  if (d.y < 0) t = Math.min(t, (r.y - c.y) / d.y)
  return t
}

// 矢印の線: from の中心と to の中心を結ぶ線のうち、2 台の外形の外に出ている部分（from の縁 → to の縁）。
// 2 台が重なるか接していて外に出る部分が無ければ、中心どうしを結ぶ
export function linkSegment(from: Equipment, to: Equipment): [Point, Point] {
  const a = { x: from.x, y: from.y }
  const b = { x: to.x, y: to.y }
  const len = Math.hypot(b.x - a.x, b.y - a.y)
  if (len === 0) return [a, b]
  const d = { x: (b.x - a.x) / len, y: (b.y - a.y) / len }
  const t0 = exitDistance(footprint(from), a, d)
  const t1 = len - exitDistance(footprint(to), b, { x: -d.x, y: -d.y })
  if (!(t1 > t0)) return [a, b]
  return [
    { x: a.x + d.x * t0, y: a.y + d.y * t0 },
    { x: a.x + d.x * t1, y: a.y + d.y * t1 },
  ]
}

// 点 at から tolerance（mm）以内にある矢印のうち、いちばん近いもの。無ければ null
export function linkHitTest(scene: Scene, at: Point, tolerance: number): Link | null {
  let best: Link | null = null
  let bestD = Infinity
  for (const l of scene.links) {
    const a = scene.equipment.find((e) => e.id === l.from)
    const b = scene.equipment.find((e) => e.id === l.to)
    if (!a || !b) continue
    const [p, q] = linkSegment(a, b)
    const d = distanceToSegment(at, p, q)
    if (d <= tolerance && d < bestD) {
      best = l
      bestD = d
    }
  }
  return best
}

// 設備 id の前の工程（つないで来る設備）と次の工程（つないで行く設備）の id
export function neighbors(scene: Scene, id: string): { prev: string[]; next: string[] } {
  return {
    prev: scene.links.filter((l) => l.to === id).map((l) => l.from),
    next: scene.links.filter((l) => l.from === id).map((l) => l.to),
  }
}
