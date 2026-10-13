// 置く・動かすときの計算（スナップと当たり判定）。DOM に触らない。
// スナップは、設備の外接の長方形の左上をグリッドに乗せる。辺がグリッドにそろい、詰めて並べやすい。

import { footprint, type Equipment, type Rotation, type Scene } from './scene'
import type { Point } from './viewport'

// 選べるスナップの間隔（mm）。0 はスナップしない
export const SNAP_STEPS: readonly number[] = [0, 10, 50, 100, 500, 1000]
export const DEFAULT_SNAP = 100

export function snapValue(v: number, step: number): number {
  if (!(step > 0)) return v
  // 浮動小数の誤差を落とす
  return Number((Math.round(v / step) * step).toPrecision(12))
}

// 設備 eq を (dx, dy) ずらすとき、外接の長方形の左上がグリッドに乗るように移動量を直す
export function snapMove(eq: Equipment, dx: number, dy: number, step: number): { dx: number; dy: number } {
  if (!(step > 0)) return { dx, dy }
  const fp = footprint(eq)
  return { dx: snapValue(fp.x + dx, step) - fp.x, dy: snapValue(fp.y + dy, step) - fp.y }
}

// これから置く設備の中心を、外接の長方形の左上がグリッドに乗る位置に直す
export function snapCenter(
  size: { width: number; depth: number; rotation: Rotation },
  center: Point,
  step: number,
): Point {
  if (!(step > 0)) return center
  const turned = size.rotation === 90 || size.rotation === 270
  const w = turned ? size.depth : size.width
  const h = turned ? size.width : size.depth
  return { x: snapValue(center.x - w / 2, step) + w / 2, y: snapValue(center.y - h / 2, step) + h / 2 }
}

// 点 p の下にある設備の id。重なっていたら上に描かれている（配列の後ろの）ものを返す
export function hitTest(scene: Scene, p: Point): string | null {
  for (let i = scene.equipment.length - 1; i >= 0; i--) {
    const eq = scene.equipment[i]!
    const fp = footprint(eq)
    if (p.x >= fp.x && p.x <= fp.x + fp.width && p.y >= fp.y && p.y <= fp.y + fp.height) return eq.id
  }
  return null
}
