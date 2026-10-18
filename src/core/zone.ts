// 置けない所: 防火壁・柱・キュービクルなど、設備も通路も入れてはいけない長方形。DOM に触らない。
// 図面の向きにそろった長方形（左上 x, y と幅・高さ、mm）で持つ。L 字などは長方形を並べて作る。

import type { Scene } from './scene'
import type { Rect } from './viewport'

export type Zone = {
  id: string
  name: string
  x: number // 左上（mm）
  y: number
  width: number // x 方向の長さ（mm）
  height: number // y 方向の長さ（mm）
}

// 置けない所として受け付けるか。理由つきで断る（null なら問題なし）
export function checkZone(z: Zone): string | null {
  if (typeof z !== 'object' || z === null) return '置けない所の形ではありません'
  if (typeof z.id !== 'string' || !z.id) return '置けない所の id が空です'
  if (typeof z.name !== 'string' || !z.name.trim()) return `置けない所 ${z.id} の名前が空です`
  if (!Number.isFinite(z.x) || !Number.isFinite(z.y)) return `置けない所 ${z.id} の位置が数ではありません`
  if (!(typeof z.width === 'number' && z.width > 0 && Number.isFinite(z.width))) return '置けない所の幅は正の数にしてください'
  if (!(typeof z.height === 'number' && z.height > 0 && Number.isFinite(z.height))) return '置けない所の奥行は正の数にしてください'
  return null
}

export function zoneRect(z: Zone): Rect {
  return { x: z.x, y: z.y, width: z.width, height: z.height }
}

// 2 点（対角の角）から長方形。向きは問わない
export function zoneFromCorners(id: string, name: string, a: { x: number; y: number }, b: { x: number; y: number }): Zone {
  return { id, name, x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) }
}

// まだ使われていない id（'zone-1', 'zone-2', ...）
export function nextZoneId(scene: Scene): string {
  let max = 0
  for (const z of scene.zones) {
    const m = /^zone-(\d+)$/.exec(z.id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `zone-${max + 1}`
}

// 次の名前（「置けない所 n」の続き）
export function nextZoneName(scene: Scene): string {
  let max = 0
  for (const z of scene.zones) {
    const m = /^置けない所 (\d+)$/.exec(z.name)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `置けない所 ${Math.max(max, scene.zones.length) + 1}`
}
