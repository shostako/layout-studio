import { describe, expect, it } from 'vitest'
import { planAiCommands } from './ai'
import { arrangeUnit, attachUnit } from './attach'
import { applyCommand, type Command } from './commands'
import { findOverlaps } from './overlap'
import { createEmptyScene, type Equipment, type Scene } from './scene'
import { INJECTION_PRESET, equipmentFromTemplate, findTemplate } from './templates'

function run(s: Scene, cmd: Command | null): Scene {
  if (!cmd) return s
  const r = applyCommand(s, cmd)
  if (!r.ok) throw new Error(r.error)
  return r.scene
}

function machine(rotation: 0 | 90 = 0, at = { x: 9000, y: 3500 }): Scene {
  const t = findTemplate(INJECTION_PRESET, 'molding-machine')!
  return run(createEmptyScene(), { type: 'add', equipment: equipmentFromTemplate(t, { id: 'eq-1', name: '成形機 1', center: at, rotation }) })
}

function attached(s: Scene, id = 'eq-1', o = {}): Scene {
  const r = attachUnit(s, id, o)
  if (!r.ok) throw new Error(r.error)
  return run(s, r.command)
}

const where = (s: Scene) => Object.fromEntries(s.equipment.map((e) => [e.name, [e.x, e.y, e.rotation]]))

describe('attachUnit（付ける）', () => {
  it('横の成形機に、取出機を載せ、型抜き機・トリミング機・ストッカー・予備を下の長辺に沿って左へ並べる', () => {
    const s = attached(machine())
    expect(where(s)).toEqual({
      '成形機 1': [9000, 3500, 0],
      // 中心から右へ 1500（長さの 0.15）、梁は上へ 800・下へ 2800
      '取出機 1': [10500, 4500, 0],
      // 列の線: 成形機の下の辺 4900 + 余白 1000 + いちばん奥行のある型抜き機の半分 750 = 6650
      // 取出機の左の端 10100 から、余白 500 ずつあけて左へ
      '型抜き機 1': [8850, 6650, 0],
      'トリミング機 1': [6700, 6650, 0],
      '台車ストッカー 1': [4700, 6650, 0],
      '台車ストッカー 1 予備': [3000, 6650, 0],
    })
    const id = (n: string) => s.equipment.find((e) => e.name === n)!.id
    expect(s.links).toEqual([
      { from: 'eq-1', to: id('取出機 1') },
      { from: id('取出機 1'), to: id('型抜き機 1') },
      { from: id('型抜き機 1'), to: id('トリミング機 1') },
      { from: id('トリミング機 1'), to: id('台車ストッカー 1') },
      { from: id('トリミング機 1'), to: id('台車ストッカー 1 予備') },
    ])
    expect(findOverlaps(s)).toEqual([])
  })

  it('取り出し側と並べる向きを選べる。基準の向きに合わない向きは断る', () => {
    const s = attached(machine(), 'eq-1', { side: 'top', toward: 'right' })
    const w = where(s)
    expect(w['取出機 1']).toEqual([7500, 2500, 0])
    expect(w['型抜き機 1']).toEqual([9150, 350, 0])
    expect(w['台車ストッカー 1 予備']![0]).toBeGreaterThan(w['台車ストッカー 1']![0]!)
    expect(findOverlaps(s)).toEqual([])
    expect(attachUnit(machine(), 'eq-1', { side: 'left' })).toMatchObject({ ok: false, error: expect.stringContaining('取り出し側は上か下') })
    expect(attachUnit(machine(90), 'eq-1', { toward: 'left' })).toMatchObject({ ok: false, error: expect.stringContaining('並べる向きは上か下') })
  })

  it('縦の成形機には、ユニットを 90 度回した形で右の長辺に沿って上へ並べる', () => {
    const s = attached(machine(90, { x: 5000, y: 10000 }))
    const w = where(s)
    expect(w['取出機 1']).toEqual([6000, 11500, 90])
    expect(w['型抜き機 1']).toEqual([8150, 9850, 90])
    for (const e of s.equipment) expect(e.rotation).toBe(90)
    expect(w['台車ストッカー 1 予備']![1]).toBeLessThan(w['型抜き機 1']![1]!)
    expect(findOverlaps(s)).toEqual([])
  })

  it('ユニットにある設備は動かして使い、無いものだけ置く。2 回目は何もしない', () => {
    let s = machine()
    const robot = equipmentFromTemplate(findTemplate(INJECTION_PRESET, 'take-out-robot')!, { id: 'eq-2', name: '取出機 A', center: { x: 7000, y: 2000 } })
    s = run(s, { type: 'add', equipment: robot })
    s = run(s, { type: 'link', links: [{ from: 'eq-2', to: 'eq-1' }] })
    const r = attachUnit(s, 'eq-1')
    expect(r.ok && r.note).toBe('成形機 1: 取り出し側 上、右へ並べる（4 台を置き、1 台を動かす）')
    s = run(s, r.ok ? r.command : null)
    expect(s.equipment.filter((e) => e.kind === 'take-out-robot')).toHaveLength(1)
    // 取出機は上へ張り出していたので取り出し側は上、成形機の中心より左にあったので右へ並べる
    expect(where(s)['取出機 A']).toEqual([7500, 2500, 0])
    // 逆向きのつなぎ（取出機 → 成形機）はそのまま使う
    expect(s.links.filter((l) => l.to === 'eq-1' || l.from === 'eq-1')).toEqual([{ from: 'eq-2', to: 'eq-1' }])
    expect(attachUnit(s, 'eq-1')).toEqual({ ok: true, command: null, note: '成形機 1: もう決まりどおりです' })
  })

  it('基準でない設備・決まりの無い種類・一覧に無い種類は断る', () => {
    const s = attached(machine())
    expect(attachUnit(s, 'eq-2')).toMatchObject({ ok: false, error: expect.stringContaining('基準の設備ではありません') })
    expect(attachUnit(s, 'eq-99')).toMatchObject({ ok: false })
    const press = createEmptyScene([{ kind: 'press', name: 'プレス機', width: 3000, depth: 2000, color: '#888888', clearance: { top: 0, right: 0, bottom: 0, left: 0 }, role: 'anchor' }])
    const p = run(press, { type: 'add', equipment: { id: 'eq-1', kind: 'press', name: 'プレス機 1', x: 0, y: 0, width: 3000, depth: 2000, rotation: 0, color: '#888888', clearance: { top: 0, right: 0, bottom: 0, left: 0 } } })
    expect(attachUnit(p, 'eq-1')).toMatchObject({ ok: false, error: expect.stringContaining('プレス機に付ける付帯設備の決まりがありません') })
    const noStocker = run(machine(), { type: 'setTemplates', templates: INJECTION_PRESET.filter((t) => t.kind !== 'cart-stocker') })
    expect(attachUnit(noStocker, 'eq-1')).toMatchObject({ ok: false, error: expect.stringContaining('cart-stocker') })
  })
})

describe('付け直しでの取出機の選び方', () => {
  it('取出機が 2 台つないであれば、つなぎの順で先の 1 台で向きを決めて使い、もう 1 台は動かさない', () => {
    let s = machine()
    const t = findTemplate(INJECTION_PRESET, 'take-out-robot')!
    // シーンの並びでは上の取出機が先だが、つなぎは下の取出機が先
    s = run(s, { type: 'add', equipment: equipmentFromTemplate(t, { id: 'eq-2', name: '取出機 上', center: { x: 7500, y: 2500 } }) })
    s = run(s, { type: 'add', equipment: equipmentFromTemplate(t, { id: 'eq-3', name: '取出機 下', center: { x: 10500, y: 4500 } }) })
    s = run(s, { type: 'link', links: [{ from: 'eq-1', to: 'eq-3' }, { from: 'eq-1', to: 'eq-2' }] })
    const after = attached(s)
    expect(where(after)['取出機 下']).toEqual([10500, 4500, 0])
    expect(where(after)['取出機 上']).toEqual([7500, 2500, 0])
    // 下の取出機から決めたので、取り出し側は下、左へ並べる
    expect(where(after)['型抜き機 1']).toEqual([8850, 6650, 0])
  })
})

describe('付け直しでのつなぎ', () => {
  it('順の入れ替わったつなぎ（取出機 → トリミング機 → 型抜き機）は、決まりのつなぎに置き換える', () => {
    let s = attached(machine())
    const id = (n: string) => s.equipment.find((e) => e.name === n)!.id
    const [robot, deg, trim] = [id('取出機 1'), id('型抜き機 1'), id('トリミング機 1')]
    s = run(s, { type: 'unlink', links: [{ from: robot, to: deg }, { from: deg, to: trim }] })
    s = run(s, { type: 'link', links: [{ from: robot, to: trim }, { from: trim, to: deg }] })
    const r = attachUnit(s, 'eq-1')
    expect(r.ok).toBe(true)
    const after = run(s, r.ok ? r.command : null)
    const has = (from: string, to: string) => after.links.some((l) => l.from === from && l.to === to)
    expect([has(robot, deg), has(deg, trim), has(robot, trim), has(trim, deg)]).toEqual([true, true, false, false])
  })
})

describe('付け直しでのストッカーの順（ユニットの外からのつなぎ）', () => {
  it('ユニットの外からのつなぎは数えず、ユニットの中からのつなぎの順で主と予備を決める', () => {
    let s = attached(machine())
    const id = (n: string) => s.equipment.find((e) => e.name === n)!.id
    // ユニットの外の設備から予備へ、先につなぐ（そのつなぎが一覧の前に来るように、いったん外してつなぎ直す）
    const ext = { ...s.equipment.find((e) => e.name === '型抜き機 1')!, id: 'ext', name: '外', x: 40000, y: 40000 }
    s = run(s, { type: 'add', equipment: ext })
    const keep = s.links
    s = { ...s, links: [{ from: 'ext', to: id('台車ストッカー 1 予備') }, ...keep] }
    const after = attached(s)
    expect(where(after)['台車ストッカー 1']).toEqual([4700, 6650, 0])
    expect(where(after)['台車ストッカー 1 予備']).toEqual([3000, 6650, 0])
  })
})

describe('付け直しでのストッカーの順（ユニットの中のほかのつなぎ）', () => {
  it('トリミング機から出るつなぎの順で主と予備を決める（取出機 → 予備のような別のつなぎは数えない）', () => {
    let s = attached(machine())
    const id = (n: string) => s.equipment.find((e) => e.name === n)!.id
    s = { ...s, links: [{ from: id('取出機 1'), to: id('台車ストッカー 1 予備') }, ...s.links] }
    const after = attached(s)
    expect(where(after)['台車ストッカー 1']).toEqual([4700, 6650, 0])
    expect(where(after)['台車ストッカー 1 予備']).toEqual([3000, 6650, 0])
    expect(after.links.some((l) => l.from === id('取出機 1') && l.to === id('台車ストッカー 1 予備'))).toBe(false)
  })
})

describe('付け直しでの余った設備', () => {
  it('余った設備を回る遠回りのつなぎがあっても輪にならない（ユニットの中の決まりと違うつなぎは外す）', () => {
    let s = attached(machine())
    const id = (n: string) => s.equipment.find((e) => e.name === n)!.id
    const [robot, deg, trim] = [id('取出機 1'), id('型抜き機 1'), id('トリミング機 1')]
    const extra = { ...s.equipment.find((e) => e.id === trim)!, id: 'x1', name: '余り', x: 20000, y: 20000 }
    s = run(s, { type: 'add', equipment: extra })
    s = run(s, { type: 'unlink', links: [{ from: deg, to: trim }] })
    s = run(s, { type: 'link', links: [{ from: robot, to: trim }, { from: trim, to: 'x1' }, { from: 'x1', to: deg }] })
    const r = attachUnit(s, 'eq-1')
    expect(r.ok).toBe(true)
    const after = run(s, r.ok ? r.command : null)
    expect(where(after)['余り']).toEqual([20000, 20000, 0])
    expect(after.links.some((l) => l.from === 'x1' || l.to === 'x1')).toBe(false)
    expect(after.links.some((l) => l.from === deg && l.to === trim)).toBe(true)
  })
})

describe('付け直しでのストッカーと予備', () => {
  it('ストッカーが 2 台あれば、つなぎの順で先のものを主の位置に置く', () => {
    let s = attached(machine())
    const id = (n: string) => s.equipment.find((e) => e.name === n)!.id
    const trim = id('トリミング機 1')
    // 主へのつなぎを外して付け直し、予備へのつなぎを先にする
    s = run(s, { type: 'unlink', links: [{ from: trim, to: id('台車ストッカー 1') }] })
    s = run(s, { type: 'link', links: [{ from: trim, to: id('台車ストッカー 1') }] })
    s = attached(s)
    expect(where(s)['台車ストッカー 1 予備']).toEqual([4700, 6650, 0])
    expect(where(s)['台車ストッカー 1']).toEqual([3000, 6650, 0])
  })
})

describe('arrangeUnit（整える）', () => {
  const nudge = (s: Scene, name: string, dx: number, dy: number) => run(s, { type: 'move', ids: [s.equipment.find((e) => e.name === name)!.id], dx, dy })

  it('詰めた並びの順と向きを保って、余白ちょうどの間隔と列の線に揃える', () => {
    const base = attached(machine())
    let s = nudge(base, 'トリミング機 1', 300, 420)
    s = nudge(s, '台車ストッカー 1', -900, -80)
    s = nudge(s, '台車ストッカー 1 予備', 600, 0) // ストッカーを越えない範囲で寄せた
    const r = arrangeUnit(s, 'eq-1')
    expect(r.ok && r.note).toBe('成形機 1: 3 台を揃える（取り出し側 下、左へ）')
    expect(where(run(s, r.ok ? r.command : null))).toEqual(where(base))
  })

  it('並びの順を入れ替えていれば、その順のまま揃える。基準の設備と取出機は動かさない', () => {
    // 型抜き機とトリミング機を入れ替える
    const base = attached(machine())
    const s = nudge(nudge(base, '型抜き機 1', -2150, 0), 'トリミング機 1', 2150, 0)
    const after = run(s, (arrangeUnit(s, 'eq-1') as { command: Command }).command)
    const w = where(after)
    expect(w['トリミング機 1']![0]).toBeGreaterThan(w['型抜き機 1']![0]!)
    expect(w['成形機 1']).toEqual([9000, 3500, 0])
    expect(w['取出機 1']).toEqual([10500, 4500, 0])
    expect(findOverlaps(after)).toEqual([])
    expect(arrangeUnit(after, 'eq-1')).toMatchObject({ ok: true, command: null })
  })
})

describe('決まりの無い基準の設備', () => {
  it('整えるも断る。省いた整える（全部）は決まりのある基準の設備だけ', () => {
    const zero = { top: 0, right: 0, bottom: 0, left: 0 }
    let s = run(machine(), {
      type: 'setTemplates',
      templates: [...INJECTION_PRESET, { kind: 'press', name: 'プレス機', width: 3000, depth: 2000, color: '#888888', clearance: zero, role: 'anchor' }],
    })
    s = run(s, { type: 'add', equipment: { id: 'p1', kind: 'press', name: 'プレス機 1', x: 40000, y: 0, width: 3000, depth: 2000, rotation: 0, color: '#888888', clearance: zero } })
    s = run(s, { type: 'add', equipment: { ...findTemplate(INJECTION_PRESET, 'cart-stocker')!, id: 'p2', name: '置き場', x: 45000, y: 0, rotation: 0, clearance: zero } as never })
    s = run(s, { type: 'link', links: [{ from: 'p1', to: 'p2' }] })
    expect(arrangeUnit(s, 'p1')).toMatchObject({ ok: false, error: expect.stringContaining('決まりがありません') })
    s = attached(s)
    const r = planAiCommands(s, [{ type: 'arrangeUnits' }])
    expect(r).toMatchObject({ ok: true, steps: [] })
  })
})

describe('AI の attachUnit・arrangeUnits', () => {
  it('付けて、整える。ids を省いた整えるは全部のユニット。もう揃っていれば当てるものは無い', () => {
    const s = machine()
    const r = planAiCommands(s, [{ type: 'attachUnit', ids: ['eq-1'] }])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.steps[0]!.text).toBe('付帯設備を付ける: 成形機 1: 取り出し側 下、左へ並べる（5 台を置き、0 台を動かす）')
    expect(r.scene.equipment).toHaveLength(6)
    const again = planAiCommands(r.scene, [{ type: 'arrangeUnits' }])
    expect(again).toMatchObject({ ok: true, steps: [] })
    expect(planAiCommands(s, [{ type: 'attachUnit', ids: ['eq-1'], side: 'up' }])).toMatchObject({ ok: false })
    expect(planAiCommands(s, [{ type: 'attachUnit' }])).toMatchObject({ ok: false })
  })
})

// 使っていない import を残さない
export type _E = Equipment
