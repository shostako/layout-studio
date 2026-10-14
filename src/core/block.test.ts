import { describe, expect, it } from 'vitest'
import { planAiCommands } from './ai'
import { placeBlock } from './block'
import { applyCommand } from './commands'
import { describeLayout, layoutSignature } from './layout'
import { findOverlaps } from './overlap'
import { createEmptyScene, equipmentBounds, type Scene } from './scene'
import { unitsOf } from './unit'

function placed(s: Scene, o: Parameters<typeof placeBlock>[1]): Scene {
  const r = placeBlock(s, o)
  if (!r.ok) throw new Error(r.error)
  const a = applyCommand(s, r.command)
  if (!a.ok) throw new Error(a.error)
  return a.scene
}

describe('placeBlock（並べる）', () => {
  it('横の成形機 7 台を 1 列に、付帯設備つきで重なりも余白への入り込みも無く並べる', () => {
    const s = placed(createEmptyScene(), { count: 7, origin: { x: 0, y: 0 } })
    expect(describeLayout(s)).toBe('成形機 7 台（横 1 列）')
    expect(s.equipment).toHaveLength(42)
    expect(findOverlaps(s)).toEqual([])
    expect([...unitsOf(s).values()].every((m) => m.length === 5)).toBe(true)
    // まとまりの本体の左上が origin
    const b = equipmentBounds(s.equipment)!
    expect([b.x, b.y]).toEqual([0, 0])
  })

  it('14 台を 2 列、縦向き、取り出し側を選んで並べる', () => {
    const two = placed(createEmptyScene(), { count: 14, columns: 2, origin: { x: 0, y: 0 } })
    expect(layoutSignature(two)).toBe('molding-machine/H:0,0,0,0,0,0,0 molding-machine/H:0,0,0,0,0,0,0 | BO')
    expect(findOverlaps(two)).toEqual([])
    const v = placed(createEmptyScene(), { count: 4, orientation: 'vertical', side: 'left', origin: { x: 0, y: 0 } })
    expect(describeLayout(v)).toBe('成形機 4 台（縦 1 列）')
    expect(findOverlaps(v)).toEqual([])
    // 取り出し側が左なので、取出機は成形機の左へ張り出す
    const m = v.equipment.find((e) => e.kind === 'molding-machine')!
    const t = v.equipment.find((e) => e.kind === 'take-out-robot')!
    expect(t.x).toBeLessThan(m.x)
  })

  it('置く所を省くと、置いてある設備の右に並べる。縦横の混在は 2 回並べて作る', () => {
    let s = placed(createEmptyScene(), { count: 3, origin: { x: 0, y: 0 } })
    const before = equipmentBounds(s.equipment)!
    s = placed(s, { count: 2, orientation: 'vertical' })
    expect(describeLayout(s)).toBe('成形機 5 台（横 3・縦 2）')
    expect(findOverlaps(s)).toEqual([])
    const added = s.equipment.slice(18)
    expect(equipmentBounds(added)!.x).toBeGreaterThan(before.x + before.width)
  })

  it('台数を列に均等に分ける（10 台 4 列は 3・3・2・2、6 台 4 列も 4 列）', () => {
    expect(describeLayout(placed(createEmptyScene(), { count: 10, columns: 4, origin: { x: 0, y: 0 } }))).toBe('成形機 10 台（横 4 列: 3・3・2・2）')
    expect(describeLayout(placed(createEmptyScene(), { count: 6, columns: 4, origin: { x: 0, y: 0 } }))).toBe('成形機 6 台（横 4 列: 2・2・1・1）')
  })

  it('台数・列・種類の不正を断る', () => {
    const s = createEmptyScene()
    expect(placeBlock(s, { count: 0 })).toMatchObject({ ok: false })
    expect(placeBlock(s, { count: 3, columns: 4 })).toMatchObject({ ok: false })
    expect(placeBlock(s, { count: 2, kind: 'cart-stocker' })).toMatchObject({ ok: false, error: expect.stringContaining('基準の設備の種類ではありません') })
    expect(placeBlock(createEmptyScene([]), { count: 1 })).toMatchObject({ ok: false, error: expect.stringContaining('基準の設備の種類がありません') })
  })

  it('AI の placeUnits', () => {
    const r = planAiCommands(createEmptyScene(), [{ type: 'placeUnits', count: 2, x: 1000, y: 1000 }])
    expect(r.ok && r.steps[0]!.text).toMatch(/^並べる: 成形機を 2 台、横向きで 1 列に並べる/)
    expect(r.ok && r.scene.equipment).toHaveLength(12)
    expect(planAiCommands(createEmptyScene(), [{ type: 'placeUnits', count: 2, x: 1000 }])).toMatchObject({ ok: false })
    expect(planAiCommands(createEmptyScene(), [{ type: 'placeUnits' }])).toMatchObject({ ok: false })
  })
})
