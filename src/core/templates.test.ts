import { describe, expect, it } from 'vitest'
import { applyCommand } from './commands'
import { createEmptyScene, type Scene } from './scene'
import { INJECTION_PRESET, checkTemplates, equipmentFromTemplate, findTemplate, mergePreset, nextEquipmentName, nextTemplateKind, type EquipmentTemplate } from './templates'

const molding = findTemplate(INJECTION_PRESET, 'molding-machine')!

describe('INJECTION_PRESET', () => {
  it('仕様の 6 種類がそろい、種類は重ならず、寸法は正', () => {
    expect(INJECTION_PRESET.map((t) => t.name)).toEqual(['成形機', '取出機', '型抜き機', 'トリミング機', '重量計', '台車ストッカー'])
    expect(new Set(INJECTION_PRESET.map((t) => t.kind)).size).toBe(INJECTION_PRESET.length)
    for (const t of INJECTION_PRESET) expect(t.width > 0 && t.depth > 0).toBe(true)
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
        equipmentFromTemplate(findTemplate(INJECTION_PRESET, 'weighing-scale')!, { id: 'eq-4', name: '成形機 9', center: { x: 0, y: 0 } }),
      ],
    }
    expect(nextEquipmentName(scene, molding)).toBe('成形機 4')
    expect(nextEquipmentName(createEmptyScene(), molding)).toBe('成形機 1')
  })
})

describe('ひな形の余白', () => {
  it('どのひな形も 0 以上の余白を持ち、置く設備に写す（ひな形と同じものを共有しない）', () => {
    for (const t of INJECTION_PRESET) for (const v of Object.values(t.clearance) as number[]) expect(v >= 0).toBe(true)
    const a = equipmentFromTemplate(molding, { id: 'eq-1', name: '成形機 1', center: { x: 0, y: 0 } })
    expect(a.clearance).toEqual(molding.clearance)
    expect(a.clearance).not.toBe(molding.clearance)
  })
})

describe('射出成形の組', () => {
  it('成形機は基準、取出機は成形機に載る、台車ストッカーは溜める。確かめを通る', () => {
    const role = (kind: string) => findTemplate(INJECTION_PRESET, kind)
    expect(role('molding-machine')?.role).toBe('anchor')
    expect(role('take-out-robot')).toMatchObject({ role: 'mounted', mountsOn: 'molding-machine' })
    expect(role('cart-stocker')?.role).toBe('buffer')
    expect(role('weighing-scale')?.role).toBeUndefined()
    expect(checkTemplates(INJECTION_PRESET)).toBeNull()
  })

  it('空のシーンは組の写しを持つ（組の値と共有しない）', () => {
    const s = createEmptyScene()
    expect(s.templates).toEqual(INJECTION_PRESET)
    expect(s.templates[0]).not.toBe(INJECTION_PRESET[0])
    expect(s.templates[0]!.clearance).not.toBe(INJECTION_PRESET[0]!.clearance)
    expect(createEmptyScene([]).templates).toEqual([])
  })
})

describe('checkTemplates', () => {
  const ok: EquipmentTemplate = { kind: 'press', name: 'プレス機', width: 3000, depth: 2000, color: '#8a6fb0', clearance: { top: 800, right: 800, bottom: 800, left: 800 } }
  const bad = (list: unknown) => checkTemplates(list)
  it('形の不正を理由つきで断る', () => {
    expect(bad('x')).toMatch('配列ではありません')
    expect(bad([ok])).toBeNull()
    expect(bad([])).toBeNull()
    expect(bad([{ ...ok, kind: 'Press 1' }])).toMatch('kind は英小文字')
    expect(bad([ok, { ...ok, name: '別' }])).toMatch('重複しています: press')
    expect(bad([ok, { ...ok, kind: 'press-2' }])).toMatch('同じ名前のひな形があります: プレス機')
    expect(bad([{ ...ok, name: '  ' }])).toMatch('名前がありません')
    expect(bad([{ ...ok, width: 0 }])).toMatch('幅と奥行は正の数')
    expect(bad([{ ...ok, color: 'red' }])).toMatch('#rrggbb')
    expect(bad([{ ...ok, clearance: { top: -1, right: 0, bottom: 0, left: 0 } }])).toMatch('余白は上・右・下・左とも 0 以上')
    expect(bad([{ ...ok, role: 'boss' }])).toMatch('役割は')
  })
  it('載る種類は、自分以外の一覧にある種類に載る', () => {
    const base = { ...ok, kind: 'base', name: '台' }
    expect(bad([base, { ...ok, role: 'mounted', mountsOn: 'base' }])).toBeNull()
    expect(bad([base, { ...ok, role: 'mounted' }])).toMatch('載り先の種類（mountsOn）が要ります')
    expect(bad([{ ...ok, role: 'mounted', mountsOn: 'press' }])).toMatch('自分の種類には載れません')
    expect(bad([{ ...ok, role: 'mounted', mountsOn: 'nothing' }])).toMatch('載り先の種類がひな形にありません: nothing')
    expect(bad([base, { ...ok, role: 'buffer', mountsOn: 'base' }])).toMatch('役割が「載る」のときだけ')
  })
})

describe('mergePreset と nextTemplateKind', () => {
  it('組のうち無い種類だけを後ろに足し、ある種類は今の値のまま。名前だけ重なれば（組）を付ける', () => {
    const mine: EquipmentTemplate[] = [
      { ...INJECTION_PRESET[0]!, width: 7000 },
      { kind: 'custom-1', name: '取出機', width: 1000, depth: 1000, color: '#888888', clearance: { top: 0, right: 0, bottom: 0, left: 0 } },
    ]
    const r = mergePreset(mine, INJECTION_PRESET)
    expect(r.map((t) => t.kind)).toEqual(['molding-machine', 'custom-1', ...INJECTION_PRESET.slice(1).map((t) => t.kind)])
    expect(r[0]!.width).toBe(7000)
    expect(r.find((t) => t.kind === 'take-out-robot')!.name).toBe('取出機（組）')
    expect(checkTemplates(r)).toBeNull()
    expect(mergePreset(INJECTION_PRESET, INJECTION_PRESET)).toHaveLength(INJECTION_PRESET.length)
  })
  it('custom-n の空いている番号', () => {
    expect(nextTemplateKind(INJECTION_PRESET)).toBe('custom-1')
    expect(nextTemplateKind([{ ...INJECTION_PRESET[0]!, kind: 'custom-1' }])).toBe('custom-2')
  })
})
