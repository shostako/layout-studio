import { describe, expect, it } from 'vitest'
import { SCENE_VERSION, createEmptyScene, footprint, nextEquipmentId, type Equipment } from './scene'

const machine: Equipment = {
  id: 'eq-1',
  kind: 'molding-machine',
  name: '成形機1',
  x: 5000,
  y: 3000,
  width: 6000,
  depth: 2000,
  rotation: 0,
  color: '#4a7bd0',
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
