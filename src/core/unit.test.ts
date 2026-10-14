import { describe, expect, it } from 'vitest'
import { planAiCommands } from './ai'
import { summarizeScene } from './aiPrompt'
import { applyCommand, type Command } from './commands'
import { createEmptyScene, footprint, type Equipment, type Scene } from './scene'
import { rotateWithUnits, unitMembers, unitsOf, withUnits } from './unit'

function eq(id: string, kind: string, x: number, y = 0, w = 1000, d = 1000): Equipment {
  return { id, kind, name: id, x, y, width: w, depth: d, rotation: 0, color: '#888888', clearance: { top: 0, right: 0, bottom: 0, left: 0 } }
}

function run(s: Scene, cmd: Command): Scene {
  const r = applyCommand(s, cmd)
  if (!r.ok) throw new Error(r.error)
  return r.scene
}

// 成形機 m1・m2 のユニット。m1 → 取出機 t1 → 型抜き d1 → ストッカー s1・s2。m2 → t2 → d2 → s3。
// m1 と m2 の両方から共有のトリミング機 x へ（どのユニットにも入らない）。重量計 w はつながっていない
function cells(): Scene {
  return {
    ...createEmptyScene(),
    equipment: [
      eq('m1', 'molding-machine', 5000, 5000, 10000, 2800),
      eq('t1', 'take-out-robot', 5000, 5800, 800, 3600),
      eq('d1', 'degating-machine', 5000, 9000),
      eq('s1', 'cart-stocker', 7000, 9000),
      eq('s2', 'cart-stocker', 9000, 9000),
      eq('m2', 'molding-machine', 5000, 20000, 10000, 2800),
      eq('t2', 'take-out-robot', 5000, 20800, 800, 3600),
      eq('d2', 'degating-machine', 5000, 24000),
      eq('s3', 'cart-stocker', 7000, 24000),
      eq('x', 'trimming-machine', 20000, 15000),
      eq('w', 'weighing-scale', 30000, 15000),
    ],
    links: [
      { from: 'm1', to: 't1' },
      { from: 't1', to: 'd1' },
      { from: 'd1', to: 's1' },
      { from: 'd1', to: 's2' },
      { from: 'm2', to: 't2' },
      { from: 't2', to: 'd2' },
      { from: 'd2', to: 's3' },
      { from: 'd1', to: 'x' },
      { from: 'd2', to: 'x' },
    ],
  }
}

describe('unitsOf', () => {
  it('基準の設備ごとに、下流へ着く設備。共有の設備とつながっていない設備は入れない', () => {
    const u = unitsOf(cells())
    expect([...u.keys()]).toEqual(['m1', 'm2'])
    expect(u.get('m1')).toEqual(['t1', 'd1', 's1', 's2'])
    expect(u.get('m2')).toEqual(['t2', 'd2', 's3'])
    expect(unitMembers(cells(), 'd1')).toEqual([])
  })

  it('ほかの基準の設備の手前で止める。載る設備は逆向きのつなぎでも入れる', () => {
    const s: Scene = {
      ...cells(),
      links: [
        { from: 't1', to: 'm1' },
        { from: 'm1', to: 'd1' },
        { from: 'd1', to: 'm2' },
        { from: 'm2', to: 'd2' },
      ],
    }
    expect(unitMembers(s, 'm1')).toEqual(['t1', 'd1'])
    expect(unitMembers(s, 'm2')).toEqual(['d2'])
  })

  it('役割で決まる: 成形機の役割を外すとユニットは無い', () => {
    const s = run(cells(), { type: 'setTemplates', templates: cells().templates.map((t) => (t.kind === 'molding-machine' ? { ...t, role: undefined } : t)).map((t) => (t.kind === 'take-out-robot' ? { ...t, role: undefined, mountsOn: undefined } : t)) })
    expect(unitsOf(s).size).toBe(0)
  })
})

describe('withUnits', () => {
  it('選んだ基準の設備のユニットを足す。付帯設備だけ選んだときは足さない', () => {
    expect(withUnits(cells(), ['m1'])).toEqual(['m1', 't1', 'd1', 's1', 's2'])
    expect(withUnits(cells(), ['s1', 'm1'])).toEqual(['s1', 'm1', 't1', 'd1', 's2'])
    expect(withUnits(cells(), ['d1'])).toEqual(['d1'])
    expect(withUnits(cells(), ['x'])).toEqual(['x'])
  })
})

describe('rotateAbout と rotateWithUnits', () => {
  it('rotateAbout は中心の位置と向きを pivot のまわりに回す（時計回り、y は下向き）', () => {
    const s = run(cells(), { type: 'rotateAbout', ids: ['m1', 'd1'], quarterTurns: 1, pivot: { x: 5000, y: 5000 } })
    const at = (id: string) => s.equipment.find((e) => e.id === id)!
    expect(at('m1')).toMatchObject({ x: 5000, y: 5000, rotation: 90 })
    // 下 4000 にあった型抜き機は、左 4000 へ
    expect(at('d1')).toMatchObject({ x: 1000, y: 5000, rotation: 90 })
    const back = run(s, { type: 'rotateAbout', ids: ['m1', 'd1'], quarterTurns: -1, pivot: { x: 5000, y: 5000 } })
    expect(back.equipment).toEqual(cells().equipment)
    expect(applyCommand(cells(), { type: 'rotateAbout', ids: ['m1'], quarterTurns: 1, pivot: null as never })).toMatchObject({ ok: false })
  })

  it('ユニットごと回すと、成形機と取出機の重なりの関係が保たれ、4 回で元に戻る', () => {
    let s = cells()
    const cmd = rotateWithUnits(s, ['m1'], 1)!
    expect(cmd).toMatchObject({ type: 'rotateAbout', ids: ['m1', 't1', 'd1', 's1', 's2'], pivot: { x: 5000, y: 5000 } })
    // 取出機と成形機の重なりの面積（回しても同じ）
    const shared = (sc: Scene) => {
      const m = footprint(sc.equipment.find((e) => e.id === 'm1')!)
      const t = footprint(sc.equipment.find((e) => e.id === 't1')!)
      const w = Math.min(m.x + m.width, t.x + t.width) - Math.max(m.x, t.x)
      const h = Math.min(m.y + m.height, t.y + t.height) - Math.max(m.y, t.y)
      return Math.max(0, w) * Math.max(0, h)
    }
    const before = shared(s)
    s = run(s, cmd)
    expect(before).toBeGreaterThan(0)
    expect(shared(s)).toBe(before)
    for (let i = 0; i < 3; i++) s = run(s, rotateWithUnits(s, ['m1'], 1)!)
    expect(s.equipment).toEqual(cells().equipment)
  })

  it('ユニットに入らない設備はその場で回し、2 つのユニットはそれぞれの成形機のまわりに回す', () => {
    const cmd = rotateWithUnits(cells(), ['m1', 'm2', 'x', 's1'], 1)!
    expect(cmd.type).toBe('batch')
    if (cmd.type !== 'batch') return
    expect(cmd.commands).toEqual([
      { type: 'rotateAbout', ids: ['m1', 't1', 'd1', 's1', 's2'], quarterTurns: 1, pivot: { x: 5000, y: 5000 } },
      { type: 'rotateAbout', ids: ['m2', 't2', 'd2', 's3'], quarterTurns: 1, pivot: { x: 5000, y: 20000 } },
      { type: 'rotate', ids: ['x'], quarterTurns: 1 },
    ])
    expect(rotateWithUnits(cells(), ['x'], -1)).toEqual({ type: 'rotate', ids: ['x'], quarterTurns: -1 })
    expect(rotateWithUnits(cells(), [], 1)).toBeNull()
  })
})

describe('AI とユニット', () => {
  it('要約にユニットを書き、AI は rotateAbout を使える', () => {
    expect(summarizeScene(cells()).units).toEqual([
      { anchor: 'm1', members: ['t1', 'd1', 's1', 's2'] },
      { anchor: 'm2', members: ['t2', 'd2', 's3'] },
    ])
    const r = planAiCommands(cells(), [{ type: 'rotateAbout', ids: ['m1', 't1'], quarterTurns: 2, pivot: { x: 5000, y: 5000 } }])
    expect(r.ok && r.steps[0]!.text).toBe('m1、t1 をまとめて (5,000 mm, 5,000 mm) のまわりに時計回りに 180° 回す')
    expect(planAiCommands(cells(), [{ type: 'rotateAbout', ids: ['m1'], quarterTurns: 1, pivot: { x: 'a' } }])).toMatchObject({ ok: false })
  })
})
