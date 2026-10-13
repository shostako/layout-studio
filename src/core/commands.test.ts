import { describe, expect, it } from 'vitest'
import { applyCommand, type Command } from './commands'
import { createEmptyScene, footprint, type Equipment, type Scene } from './scene'

function eq(id: string, over: Partial<Equipment> = {}): Equipment {
  return { id, kind: 'molding-machine', name: id, x: 1000, y: 2000, width: 3000, depth: 1500, rotation: 0, color: '#888', clearance: { top: 0, right: 0, bottom: 0, left: 0 }, ...over }
}

function sceneWith(...items: Equipment[]): Scene {
  return { ...createEmptyScene(), equipment: items }
}

function ok(scene: Scene, cmd: Command): Scene {
  const r = applyCommand(scene, cmd)
  if (!r.ok) throw new Error(r.error)
  return r.scene
}

function err(scene: Scene, cmd: Command): string {
  const r = applyCommand(scene, cmd)
  if (r.ok) throw new Error('失敗するはずが通った')
  return r.error
}

describe('add', () => {
  it('設備を末尾に足し、元のシーンは変えない', () => {
    const before = sceneWith(eq('a'))
    const after = ok(before, { type: 'add', equipment: eq('b') })
    expect(after.equipment.map((e) => e.id)).toEqual(['a', 'b'])
    expect(before.equipment.map((e) => e.id)).toEqual(['a'])
  })

  it('id の重複・空、寸法が 0 以下、回転が 90 度刻みでないものは断る', () => {
    const s = sceneWith(eq('a'))
    expect(err(s, { type: 'add', equipment: eq('a') })).toMatch('重複')
    expect(err(s, { type: 'add', equipment: eq('') })).toMatch('空')
    expect(err(s, { type: 'add', equipment: eq('b', { width: 0 }) })).toMatch('正の数')
    expect(err(s, { type: 'add', equipment: eq('b', { depth: -1 }) })).toMatch('正の数')
    expect(err(s, { type: 'add', equipment: eq('b', { x: NaN }) })).toMatch('位置')
    expect(err(s, { type: 'add', equipment: eq('b', { rotation: 45 as never }) })).toMatch('回転')
  })
})

describe('move', () => {
  it('指定した設備だけをずらす', () => {
    const s = sceneWith(eq('a'), eq('b'), eq('c'))
    const after = ok(s, { type: 'move', ids: ['a', 'c'], dx: 500, dy: -200 })
    expect(after.equipment.map((e) => [e.x, e.y])).toEqual([
      [1500, 1800],
      [1000, 2000],
      [1500, 1800],
    ])
    // 動かさない設備は同じものを共有する
    expect(after.equipment[1]).toBe(s.equipment[1])
  })

  it('無い id、空の対象、数でない移動量は断る', () => {
    const s = sceneWith(eq('a'))
    expect(err(s, { type: 'move', ids: ['x'], dx: 1, dy: 1 })).toMatch('見つかりません: x')
    expect(err(s, { type: 'move', ids: [], dx: 1, dy: 1 })).toMatch('ありません')
    expect(err(s, { type: 'move', ids: ['a', 'a'], dx: 1, dy: 1 })).toMatch('重複')
    expect(err(s, { type: 'move', ids: ['a'], dx: Infinity, dy: 1 })).toMatch('数ではありません')
  })
})

describe('rotate', () => {
  it('90 度刻みで回し、一周で元に戻る。負は反時計回り', () => {
    const s = sceneWith(eq('a', { rotation: 270 }))
    expect(ok(s, { type: 'rotate', ids: ['a'], quarterTurns: 1 }).equipment[0]!.rotation).toBe(0)
    expect(ok(s, { type: 'rotate', ids: ['a'], quarterTurns: -1 }).equipment[0]!.rotation).toBe(180)
    expect(ok(s, { type: 'rotate', ids: ['a'], quarterTurns: 4 }).equipment[0]!.rotation).toBe(270)
    expect(ok(s, { type: 'rotate', ids: ['a'], quarterTurns: -6 }).equipment[0]!.rotation).toBe(90)
  })

  it('中心のまわりに回すので位置は変わらない', () => {
    const after = ok(sceneWith(eq('a')), { type: 'rotate', ids: ['a'], quarterTurns: 1 })
    expect(after.equipment[0]).toMatchObject({ x: 1000, y: 2000, rotation: 90 })
  })

  it('整数でない回す量は断る', () => {
    expect(err(sceneWith(eq('a')), { type: 'rotate', ids: ['a'], quarterTurns: 0.5 })).toMatch('整数倍')
  })
})

describe('remove', () => {
  it('指定した設備を消す', () => {
    const after = ok(sceneWith(eq('a'), eq('b'), eq('c')), { type: 'remove', ids: ['a', 'c'] })
    expect(after.equipment.map((e) => e.id)).toEqual(['b'])
  })

  it('無い id が混じっていたら何も消さずに断る', () => {
    expect(err(sceneWith(eq('a')), { type: 'remove', ids: ['a', 'z'] })).toMatch('見つかりません: z')
  })
})

describe('duplicate', () => {
  it('写しを末尾に足し、ずらして、名前は番号の続きにする', () => {
    const s = sceneWith(eq('a', { name: '成形機 1' }), eq('b', { name: '成形機 2', rotation: 90, color: '#123456' }))
    const after = ok(s, { type: 'duplicate', ids: ['a', 'b'], newIds: ['c', 'd'], dx: 3000, dy: 0 })
    expect(after.equipment.map((e) => [e.id, e.name, e.x])).toEqual([
      ['a', '成形機 1', 1000],
      ['b', '成形機 2', 1000],
      ['c', '成形機 3', 4000],
      ['d', '成形機 4', 4000],
    ])
    // 寸法・回転・色・種類は元のまま
    expect(after.equipment[3]).toMatchObject({ kind: 'molding-machine', width: 3000, depth: 1500, rotation: 90, color: '#123456' })
  })

  it('id が足りない・重複する、無い設備、数でないずらし量は何も足さずに断る', () => {
    const s = sceneWith(eq('a'), eq('b'))
    expect(err(s, { type: 'duplicate', ids: ['a', 'b'], newIds: ['c'], dx: 0, dy: 0 })).toMatch('数が')
    expect(err(s, { type: 'duplicate', ids: ['a', 'b'], newIds: ['c', 'c'], dx: 0, dy: 0 })).toMatch('重複')
    expect(err(s, { type: 'duplicate', ids: ['a'], newIds: ['b'], dx: 0, dy: 0 })).toMatch('重複')
    expect(err(s, { type: 'duplicate', ids: ['z'], newIds: ['c'], dx: 0, dy: 0 })).toMatch('見つかりません')
    expect(err(s, { type: 'duplicate', ids: ['a'], newIds: ['c'], dx: NaN, dy: 0 })).toMatch('数ではありません')
  })
})

describe('update', () => {
  it('書いた項目だけを変え、回転は変えない', () => {
    const s = sceneWith(eq('a'), eq('b'))
    const after = ok(s, { type: 'update', ids: ['a'], changes: { name: ' 成形機 A ', color: '#123' } })
    expect(after.equipment[0]).toMatchObject({ name: '成形機 A', width: 3000, depth: 1500, x: 1000, y: 2000, rotation: 0, color: '#123' })
    expect(after.equipment[1]).toBe(s.equipment[1])
  })

  it('寸法を変えても外接の長方形の左上は動かない（回転していても）', () => {
    for (const rotation of [0, 90, 180, 270] as const) {
      const s = sceneWith(eq('a', { rotation }))
      const before = footprint(s.equipment[0]!)
      const after = ok(s, { type: 'update', ids: ['a'], changes: { width: 5000, depth: 1000 } }).equipment[0]!
      expect(after).toMatchObject({ width: 5000, depth: 1000, rotation })
      const fp = footprint(after)
      expect([fp.x, fp.y]).toEqual([before.x, before.y])
    }
  })

  it('色はまとめて変えられ、小文字にそろえる', () => {
    const after = ok(sceneWith(eq('a'), eq('b')), { type: 'update', ids: ['a', 'b'], changes: { color: '#AABBCC' } })
    expect(after.equipment.map((e) => e.color)).toEqual(['#aabbcc', '#aabbcc'])
  })

  it('空の名前、0 以下の寸法、色の形でないもの、変える項目なしは断る', () => {
    const s = sceneWith(eq('a'))
    expect(err(s, { type: 'update', ids: ['a'], changes: { name: '  ' } })).toMatch('名前')
    expect(err(s, { type: 'update', ids: ['a'], changes: { width: 0 } })).toMatch('正の数')
    expect(err(s, { type: 'update', ids: ['a'], changes: { depth: Infinity } })).toMatch('正の数')
    expect(err(s, { type: 'update', ids: ['a'], changes: { color: 'red' } })).toMatch('#rrggbb')
    expect(err(s, { type: 'update', ids: ['a'], changes: {} })).toMatch('変える項目')
    expect(err(s, { type: 'update', ids: ['z'], changes: { width: 1 } })).toMatch('見つかりません')
  })
})

describe('余白（clearance）', () => {
  it('add で余白を書かなければ 0、書けばその値で置く', () => {
    const { clearance: _, ...bare } = eq('a')
    const s = ok(createEmptyScene(), { type: 'add', equipment: bare as Equipment })
    expect(s.equipment[0]!.clearance).toEqual({ top: 0, right: 0, bottom: 0, left: 0 })
    const c = { top: 1, right: 2, bottom: 3, left: 4 }
    expect(ok(createEmptyScene(), { type: 'add', equipment: eq('a', { clearance: c }) }).equipment[0]!.clearance).toEqual(c)
  })

  it('add で負の数・数でない余白、辺の欠けた余白は断る', () => {
    expect(err(createEmptyScene(), { type: 'add', equipment: eq('a', { clearance: { top: -1, right: 0, bottom: 0, left: 0 } }) })).toMatch('余白')
    expect(err(createEmptyScene(), { type: 'add', equipment: eq('a', { clearance: { top: 0, right: 0, bottom: 0 } as never }) })).toMatch('余白')
    expect(err(createEmptyScene(), { type: 'add', equipment: eq('a', { clearance: 5 as never }) })).toMatch('余白')
  })

  it('update は書いた辺だけ変え、位置と寸法は動かさない。複数をまとめて変えられる', () => {
    const s = sceneWith(eq('a', { clearance: { top: 1, right: 2, bottom: 3, left: 4 } }), eq('b'))
    const after = ok(s, { type: 'update', ids: ['a', 'b'], changes: { clearance: { left: 900 } } })
    expect(after.equipment[0]).toMatchObject({ x: 1000, y: 2000, width: 3000, clearance: { top: 1, right: 2, bottom: 3, left: 900 } })
    expect(after.equipment[1]!.clearance).toEqual({ top: 0, right: 0, bottom: 0, left: 900 })
    expect(s.equipment[0]!.clearance.left).toBe(4)
  })

  it('update で負の数や辺の無い余白は断る', () => {
    const s = sceneWith(eq('a'))
    expect(err(s, { type: 'update', ids: ['a'], changes: { clearance: { top: -5 } } })).toMatch('0 以上')
    expect(err(s, { type: 'update', ids: ['a'], changes: { clearance: { right: NaN } } })).toMatch('0 以上')
    expect(err(s, { type: 'update', ids: ['a'], changes: { clearance: {} } })).toMatch('辺')
  })

  it('回しても余白の値は持ったまま（向きは worldClearance で回る）', () => {
    const c = { top: 1, right: 2, bottom: 3, left: 4 }
    const after = ok(sceneWith(eq('a', { clearance: c })), { type: 'rotate', ids: ['a'], quarterTurns: 1 })
    expect(after.equipment[0]!.clearance).toEqual(c)
  })
})

describe('batch', () => {
  it('順に当て、前の結果に次を当てる', () => {
    const after = ok(sceneWith(eq('a')), {
      type: 'batch',
      commands: [
        { type: 'move', ids: ['a'], dx: 500, dy: 0 },
        { type: 'add', equipment: eq('b') },
        { type: 'move', ids: ['a', 'b'], dx: 0, dy: 100 },
      ],
    })
    expect(after.equipment.map((e) => [e.id, e.x, e.y])).toEqual([
      ['a', 1500, 2100],
      ['b', 1000, 2100],
    ])
  })

  it('1 つでも断られたら何も当てず、何番目かを理由に添える', () => {
    const s = sceneWith(eq('a'))
    const r = applyCommand(s, {
      type: 'batch',
      commands: [
        { type: 'move', ids: ['a'], dx: 500, dy: 0 },
        { type: 'remove', ids: ['z'] },
      ],
    })
    expect(r).toEqual({ ok: false, error: '2 番目（remove）: 設備が見つかりません: z' })
    expect(s.equipment[0]!.x).toBe(1000)
  })

  it('空のまとめは断る', () => {
    expect(err(sceneWith(), { type: 'batch', commands: [] })).toMatch('ありません')
  })
})
