import { describe, expect, it } from 'vitest'
import { hitTest, snapCenter, snapMove, snapValue } from './placement'
import { createEmptyScene, footprint, type Equipment, type Scene } from './scene'

function eq(id: string, over: Partial<Equipment> = {}): Equipment {
  return { id, kind: 'k', name: id, x: 1000, y: 2000, width: 3000, depth: 1500, rotation: 0, color: '#888', clearance: { top: 0, right: 0, bottom: 0, left: 0 }, ...over }
}

describe('snapValue', () => {
  it('近いほうの倍数に丸める。0 はそのまま', () => {
    expect(snapValue(149, 100)).toBe(100)
    expect(snapValue(151, 100)).toBe(200)
    expect(snapValue(-151, 100)).toBe(-200)
    expect(snapValue(123.4, 0)).toBe(123.4)
    expect(snapValue(0.3, 0.1)).toBe(0.3)
  })
})

describe('snapMove', () => {
  it('動かした後の外接の長方形の左上がグリッドに乗る', () => {
    const e = eq('a', { x: 1010, y: 2030, width: 3000, depth: 1500 }) // 左上 (-490, 1280)
    const d = snapMove(e, 260, 30, 100)
    const moved = footprint({ ...e, x: e.x + d.dx, y: e.y + d.dy })
    expect(moved.x).toBe(-200)
    expect(moved.y).toBe(1300)
  })

  it('回転していれば回した後の外接の長方形で合わせる', () => {
    const e = eq('a', { x: 0, y: 0, width: 3000, depth: 1500, rotation: 90 }) // 外接 1500 × 3000、左上 (-750, -1500)
    const d = snapMove(e, 0, 0, 500)
    const fp = footprint({ ...e, x: e.x + d.dx, y: e.y + d.dy })
    expect(fp.x).toBe(-500) // -750 を丸める（回さない 3000 × 1500 なら -1500 のまま）
    expect(fp.y).toBe(-1500)
  })

  it('間隔 0 は移動量をそのまま返す', () => {
    expect(snapMove(eq('a'), 12.5, -3, 0)).toEqual({ dx: 12.5, dy: -3 })
  })
})

describe('snapCenter', () => {
  it('置く前の中心を、左上がグリッドに乗る位置に直す', () => {
    expect(snapCenter({ width: 1500, depth: 1200, rotation: 0 }, { x: 1040, y: 980 }, 100)).toEqual({ x: 1050, y: 1000 })
    expect(snapCenter({ width: 1500, depth: 1200, rotation: 90 }, { x: 1040, y: 980 }, 100)).toEqual({ x: 1000, y: 950 })
    expect(snapCenter({ width: 1500, depth: 1200, rotation: 0 }, { x: 1040, y: 980 }, 0)).toEqual({ x: 1040, y: 980 })
  })
})

describe('hitTest', () => {
  const scene: Scene = {
    ...createEmptyScene(),
    equipment: [eq('a', { x: 0, y: 0, width: 2000, depth: 2000 }), eq('b', { x: 900, y: 0, width: 1000, depth: 4000, rotation: 90 })],
  }
  it('点を含む設備のうち、上に描かれているものを返す', () => {
    expect(hitTest(scene, { x: 800, y: 0 })).toBe('b') // 重なり
    expect(hitTest(scene, { x: -900, y: 800 })).toBe('a')
    expect(hitTest(scene, { x: 2800, y: 0 })).toBe('b') // 回して横長になった b の右端付近
    expect(hitTest(scene, { x: 900, y: 900 })).toBe('a') // b は回して奥行 1000 なので y=900 は外
    expect(hitTest(scene, { x: 5000, y: 0 })).toBe(null)
  })
})
