import { describe, expect, it } from 'vitest'
import type { Command } from './commands'
import { HISTORY_LIMIT, canRedo, canUndo, createHistory, execute, redo, undo, type History } from './history'
import { createEmptyScene, type Equipment } from './scene'

function eq(id: string): Equipment {
  return { id, kind: 'weigher', name: id, x: 0, y: 0, width: 800, depth: 600, rotation: 0, color: '#888' }
}

function run(h: History, cmd: Command): History {
  const r = execute(h, cmd)
  if (!r.ok) throw new Error(r.error)
  return r.history
}

const ids = (h: History) => h.present.equipment.map((e) => e.id)

describe('history', () => {
  it('実行・元に戻す・やり直すで、シーンが行き来する', () => {
    let h = createHistory(createEmptyScene())
    expect(canUndo(h)).toBe(false)
    h = run(h, { type: 'add', equipment: eq('a') })
    h = run(h, { type: 'add', equipment: eq('b') })
    expect(ids(h)).toEqual(['a', 'b'])

    h = undo(h)
    expect(ids(h)).toEqual(['a'])
    expect(canRedo(h)).toBe(true)
    h = undo(h)
    expect(ids(h)).toEqual([])
    expect(canUndo(h)).toBe(false)
    expect(undo(h)).toBe(h) // 戻すものが無ければそのまま

    h = redo(h)
    h = redo(h)
    expect(ids(h)).toEqual(['a', 'b'])
    expect(canRedo(h)).toBe(false)
    expect(redo(h)).toBe(h)
  })

  it('戻したあとに新しく実行すると、やり直しの列は消える', () => {
    let h = createHistory(createEmptyScene())
    h = run(h, { type: 'add', equipment: eq('a') })
    h = undo(h)
    h = run(h, { type: 'add', equipment: eq('b') })
    expect(ids(h)).toEqual(['b'])
    expect(canRedo(h)).toBe(false)
  })

  it('失敗したコマンドは履歴に積まない', () => {
    const h = run(createHistory(createEmptyScene()), { type: 'add', equipment: eq('a') })
    const r = execute(h, { type: 'move', ids: ['nope'], dx: 1, dy: 0 })
    expect(r.ok).toBe(false)
    expect(r.history).toBe(h)
  })

  it(`戻せるのは直近 ${HISTORY_LIMIT} 回まで`, () => {
    let h = run(createHistory(createEmptyScene()), { type: 'add', equipment: eq('a') })
    for (let i = 0; i < HISTORY_LIMIT + 10; i++) h = run(h, { type: 'move', ids: ['a'], dx: 1, dy: 0 })
    expect(h.past.length).toBe(HISTORY_LIMIT)
    while (canUndo(h)) h = undo(h)
    expect(h.present.equipment[0]!.x).toBe(10) // 最初の 10 回の移動は戻せない
  })
})
