import { describe, expect, it } from 'vitest'
import { applyCommand, type Command } from './commands'
import { createEmptyScene, type Equipment, type Scene } from './scene'

function eq(id: string, over: Partial<Equipment> = {}): Equipment {
  return { id, kind: 'molding-machine', name: id, x: 1000, y: 2000, width: 3000, depth: 1500, rotation: 0, color: '#888', ...over }
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
