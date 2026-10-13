// 設備の種類のひな形。寸法は架空の目安で、置くときに変えて使う。DOM に触らない。

import type { Point } from './viewport'
import type { Equipment, Rotation, Scene } from './scene'

export type EquipmentTemplate = {
  kind: string
  name: string
  width: number // mm。回転 0 のときの x 方向
  depth: number // mm。回転 0 のときの y 方向
  color: string
}

// 工程の順に並べる。寸法は架空（実機の寸法ではない）
export const TEMPLATES: readonly EquipmentTemplate[] = [
  { kind: 'molding-machine', name: '成形機', width: 6000, depth: 2000, color: '#5b8bd9' },
  { kind: 'take-out-robot', name: '取出機', width: 1500, depth: 1200, color: '#4fae8a' },
  { kind: 'degating-machine', name: '型抜き機', width: 1500, depth: 1500, color: '#d9a44a' },
  { kind: 'trimming-machine', name: 'トリミング機', width: 1800, depth: 1200, color: '#c97a5b' },
  { kind: 'weighing-scale', name: '重量計', width: 800, depth: 600, color: '#9a7fc9' },
  { kind: 'cart-stocker', name: '台車ストッカー', width: 1200, depth: 1000, color: '#7f8a99' },
]

export function findTemplate(kind: string): EquipmentTemplate | undefined {
  return TEMPLATES.find((t) => t.kind === kind)
}

// 同じ種類の名前の番号の続き（「成形機 1」「成形機 2」…）。消した番号は詰めない
export function nextEquipmentName(scene: Scene, t: EquipmentTemplate): string {
  let max = 0
  const prefix = `${t.name} `
  for (const eq of scene.equipment) {
    if (eq.kind !== t.kind || !eq.name.startsWith(prefix)) continue
    const n = Number(eq.name.slice(prefix.length))
    if (Number.isInteger(n) && n > max) max = n
  }
  return `${t.name} ${max + 1}`
}

export type PlaceOptions = {
  id: string
  name: string
  center: Point
  width?: number // 省略するとひな形の寸法
  depth?: number
  rotation?: Rotation
}

// ひな形から、置く設備を作る。add コマンドに渡す
export function equipmentFromTemplate(t: EquipmentTemplate, o: PlaceOptions): Equipment {
  return {
    id: o.id,
    kind: t.kind,
    name: o.name,
    x: o.center.x,
    y: o.center.y,
    width: o.width ?? t.width,
    depth: o.depth ?? t.depth,
    rotation: o.rotation ?? 0,
    color: t.color,
  }
}
