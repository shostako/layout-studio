import { describe, expect, it } from 'vitest'
import { SCENE_VERSION, clearanceRect, createEmptyScene, worldClearance, duplicateName, equipmentBounds, footprint, nextEquipmentId, nextEquipmentIds, type Equipment } from './scene'

const machine: Equipment = {
  id: 'eq-1',
  kind: 'molding-machine',
  name: '成形機1',
  x: 5000,
  y: 3000,
  width: 6000,
  depth: 2000,
  rotation: 0,
  color: '#4a7bd0', clearance: { top: 0, right: 0, bottom: 0, left: 0 },
}

describe('createEmptyScene', () => {
  it('設備が空で、現行の版を持つ', () => {
    const scene = createEmptyScene()
    expect(scene.version).toBe(SCENE_VERSION)
    expect(scene.equipment).toEqual([])
  })
})

describe('footprint', () => {
  it('回転 0 では幅が x、奥行が y で、中心が x, y', () => {
    expect(footprint(machine)).toEqual({ x: 2000, y: 2000, width: 6000, height: 2000 })
  })

  it('90 度と 270 度では幅と奥行が入れ替わり、中心は動かない', () => {
    expect(footprint({ ...machine, rotation: 90 })).toEqual({ x: 4000, y: 0, width: 2000, height: 6000 })
    expect(footprint({ ...machine, rotation: 270 })).toEqual(footprint({ ...machine, rotation: 90 }))
    expect(footprint({ ...machine, rotation: 180 })).toEqual(footprint(machine))
  })
})

describe('nextEquipmentId', () => {
  it('空なら eq-1、あれば最大の番号の次', () => {
    const scene = createEmptyScene()
    expect(nextEquipmentId(scene)).toBe('eq-1')
    const withSome = { ...scene, equipment: [machine, { ...machine, id: 'eq-7' }, { ...machine, id: 'custom' }] }
    expect(nextEquipmentId(withSome)).toBe('eq-8')
  })
})

describe('duplicateName', () => {
  const named = (...names: string[]) => ({ ...createEmptyScene(), equipment: names.map((name, i) => ({ ...machine, id: `eq-${i}`, name })) })

  it('同じ名前の番号の続きにする。消した番号は詰めない', () => {
    expect(duplicateName(named('成形機 1', '成形機 3', '取出機 7'), '成形機 1')).toBe('成形機 4')
  })

  it('番号の無い名前は 2 から振る', () => {
    expect(duplicateName(named('予備'), '予備')).toBe('予備 2')
    expect(duplicateName(named('予備', '予備 2'), '予備')).toBe('予備 3')
  })
})

describe('equipmentBounds', () => {
  it('回転を考えた外接の長方形をまとめて囲む', () => {
    const a = { ...machine, x: 3000, y: 1000, width: 6000, depth: 2000, rotation: 0 as const }
    const b = { ...machine, x: 10000, y: 5000, width: 6000, depth: 2000, rotation: 90 as const }
    expect(equipmentBounds([a, b])).toEqual({ x: 0, y: 0, width: 11000, height: 8000 })
    expect(equipmentBounds([])).toBeNull()
  })
})

describe('nextEquipmentIds', () => {
  it('使われている番号の続きを n 個', () => {
    const s = { ...createEmptyScene(), equipment: [{ ...machine, id: 'eq-4' }] }
    expect(nextEquipmentIds(s, 3)).toEqual(['eq-5', 'eq-6', 'eq-7'])
  })
})

describe('worldClearance と clearanceRect', () => {
  const c = { ...machine, clearance: { top: 100, right: 200, bottom: 300, left: 400 } }

  it('回転 0 ではそのまま。余白まで含めた長方形は外接の長方形を広げたもの', () => {
    expect(worldClearance(c)).toEqual({ top: 100, right: 200, bottom: 300, left: 400 })
    expect(clearanceRect(c)).toEqual({ x: 1600, y: 1900, width: 6600, height: 2400 })
  })

  it('時計回りに回すと余白も回る（90 度で上の余白が右へ）', () => {
    expect(worldClearance({ ...c, rotation: 90 })).toEqual({ top: 400, right: 100, bottom: 200, left: 300 })
    expect(worldClearance({ ...c, rotation: 180 })).toEqual({ top: 300, right: 400, bottom: 100, left: 200 })
    expect(worldClearance({ ...c, rotation: 270 })).toEqual({ top: 200, right: 300, bottom: 400, left: 100 })
    // 90 度: 外接 (4000, 0)〜(6000, 6000) を 上 400・右 100・下 200・左 300 広げる
    expect(clearanceRect({ ...c, rotation: 90 })).toEqual({ x: 3700, y: -400, width: 2400, height: 6600 })
  })
})
