import { describe, expect, it } from 'vitest'
import { applyCommand } from './commands'
import { createEmptyScene, type Scene } from './scene'
import { TEMPLATES, equipmentFromTemplate, findTemplate, nextEquipmentName } from './templates'

const molding = findTemplate('molding-machine')!

describe('TEMPLATES', () => {
  it('仕様の 6 種類がそろい、種類は重ならず、寸法は正', () => {
    expect(TEMPLATES.map((t) => t.name)).toEqual(['成形機', '取出機', '型抜き機', 'トリミング機', '重量計', '台車ストッカー'])
    expect(new Set(TEMPLATES.map((t) => t.kind)).size).toBe(TEMPLATES.length)
    for (const t of TEMPLATES) expect(t.width > 0 && t.depth > 0).toBe(true)
  })
})

describe('equipmentFromTemplate', () => {
  it('ひな形の寸法と色で作り、寸法と回転は変えられる。add コマンドで置ける', () => {
    const a = equipmentFromTemplate(molding, { id: 'eq-1', name: '成形機 1', center: { x: 5000, y: 3000 } })
    expect(a).toMatchObject({ kind: 'molding-machine', x: 5000, y: 3000, width: 10000, depth: 2800, rotation: 0 })
    const b = equipmentFromTemplate(molding, {
      id: 'eq-2',
      name: '成形機 2',
      center: { x: 0, y: 0 },
      width: 7000,
      depth: 2200,
      rotation: 90,
    })
    expect(b).toMatchObject({ width: 7000, depth: 2200, rotation: 90, color: molding.color })
    expect(applyCommand(createEmptyScene(), { type: 'add', equipment: b }).ok).toBe(true)
  })
})

describe('nextEquipmentName', () => {
  it('同じ種類の番号の最大 + 1。ほかの種類や番号のない名前は数えない', () => {
    const scene: Scene = {
      ...createEmptyScene(),
      equipment: [
        equipmentFromTemplate(molding, { id: 'eq-1', name: '成形機 1', center: { x: 0, y: 0 } }),
        equipmentFromTemplate(molding, { id: 'eq-2', name: '成形機 3', center: { x: 0, y: 0 } }),
        equipmentFromTemplate(molding, { id: 'eq-3', name: '予備', center: { x: 0, y: 0 } }),
        equipmentFromTemplate(findTemplate('weighing-scale')!, { id: 'eq-4', name: '成形機 9', center: { x: 0, y: 0 } }),
      ],
    }
    expect(nextEquipmentName(scene, molding)).toBe('成形機 4')
    expect(nextEquipmentName(createEmptyScene(), molding)).toBe('成形機 1')
  })
})

describe('ひな形の余白', () => {
  it('どのひな形も 0 以上の余白を持ち、置く設備に写す（ひな形と同じものを共有しない）', () => {
    for (const t of TEMPLATES) for (const v of Object.values(t.clearance)) expect(v >= 0).toBe(true)
    const a = equipmentFromTemplate(molding, { id: 'eq-1', name: '成形機 1', center: { x: 0, y: 0 } })
    expect(a.clearance).toEqual(molding.clearance)
    expect(a.clearance).not.toBe(molding.clearance)
  })
})
