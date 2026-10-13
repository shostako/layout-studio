import { describe, expect, it } from 'vitest'
import {
  aisleHitTest,
  aisleLength,
  aisleMidpoints,
  aisleVertexAt,
  checkAisle,
  distanceToSegment,
  insertAisleVertex,
  moveAisleVertex,
  nextAisleId,
  nextAisleName,
  removeAisleVertex,
  type Aisle,
} from './aisle'
import { applyCommand, type Command } from './commands'
import { SCENE_VERSION, createEmptyScene, type Scene } from './scene'
import { parseScene, serializeScene } from './sceneFile'

function aisle(id: string, xy: [number, number][], over: Partial<Aisle> = {}): Aisle {
  return { id, name: id, points: xy.map(([x, y]) => ({ x, y })), width: 1500, closed: false, ...over }
}

// L 字の通路: (0, 0) → (10000, 0) → (10000, 5000)
const ell = aisle('aisle-1', [
  [0, 0],
  [10000, 0],
  [10000, 5000],
])

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

describe('checkAisle', () => {
  it('2 点以上で幅が正なら受け付ける。自分と交わってもよい', () => {
    expect(checkAisle(aisle('a', [[0, 0], [1000, 0]]))).toBeNull()
    expect(checkAisle(ell)).toBeNull()
    // 8 の字に交わる
    expect(checkAisle(aisle('a', [[0, 0], [1000, 1000], [1000, 0], [0, 1000]]))).toBeNull()
  })

  it('頂点の数、同じ点の連続、幅、座標を確かめる', () => {
    expect(checkAisle(aisle('a', [[0, 0]]))).toMatch('2 つ以上')
    expect(checkAisle(aisle('a', [[0, 0], [1000, 0]], { closed: true }))).toMatch('3 つ以上')
    expect(checkAisle(aisle('a', [[0, 0], [0, 0], [1000, 0]]))).toMatch('同じ点')
    expect(checkAisle(aisle('a', [[0, 0], [1000, 0], [0, 0]], { closed: true }))).toMatch('同じ点')
    expect(checkAisle(aisle('a', [[0, 0], [1000, 0]], { width: 0 }))).toMatch('正の数')
    expect(checkAisle(aisle('a', [[0, 0], [1000, 0]], { width: Infinity }))).toMatch('正の数')
    expect(checkAisle({ ...aisle('a', [[0, 0], [1000, 0]]), points: [{ x: 0, y: 0 }, { x: NaN, y: 0 }] })).toMatch('数ではありません')
    expect(checkAisle(aisle('a', [[0, 0], [1000, 0]], { name: ' ' }))).toMatch('名前')
  })

  it('開いた通路は最後と最初が同じ点でもよい（形の上で輪になるだけ）', () => {
    expect(checkAisle(aisle('a', [[0, 0], [1000, 0], [1000, 1000], [0, 0]]))).toBeNull()
  })
})

describe('長さと当たり判定', () => {
  it('中心線の長さ。周回は閉じる辺も足す', () => {
    expect(aisleLength(ell)).toBe(15000)
    expect(aisleLength({ ...ell, closed: true })).toBeCloseTo(15000 + Math.hypot(10000, 5000))
  })

  it('線分との距離', () => {
    const a = { x: 0, y: 0 }
    const b = { x: 10, y: 0 }
    expect(distanceToSegment({ x: 5, y: 3 }, a, b)).toBe(3)
    expect(distanceToSegment({ x: -3, y: 4 }, a, b)).toBe(5)
    expect(distanceToSegment({ x: 1, y: 1 }, a, a)).toBeCloseTo(Math.SQRT2)
  })

  it('中心線から幅の半分以内なら当たり。後ろに描いたものが勝つ', () => {
    const s: Scene = { ...createEmptyScene(), aisles: [ell] }
    expect(aisleHitTest(s, { x: 5000, y: 750 })).toBe('aisle-1')
    expect(aisleHitTest(s, { x: 5000, y: 751 })).toBeNull()
    expect(aisleHitTest(s, { x: 5000, y: 800 }, 50)).toBe('aisle-1')
    expect(aisleHitTest(s, { x: 9500, y: 4000 })).toBe('aisle-1')
    // 周回でなければ、閉じる辺の上は当たらない
    expect(aisleHitTest(s, { x: 5000, y: 2500 })).toBeNull()
    expect(aisleHitTest({ ...s, aisles: [{ ...ell, closed: true }] }, { x: 5000, y: 2500 })).toBe('aisle-1')
    const two: Scene = { ...s, aisles: [ell, aisle('aisle-2', [[5000, -2000], [5000, 2000]])] }
    expect(aisleHitTest(two, { x: 5000, y: 0 })).toBe('aisle-2')
  })

  it('次の id と名前は番号の続き', () => {
    const s: Scene = { ...createEmptyScene(), aisles: [ell, aisle('aisle-7', [[0, 0], [1, 0]], { name: '通路 3' })] }
    expect(nextAisleId(createEmptyScene())).toBe('aisle-1')
    expect(nextAisleId(s)).toBe('aisle-8')
    expect(nextAisleName(createEmptyScene())).toBe('通路 1')
    expect(nextAisleName(s)).toBe('通路 4')
  })
})

describe('通路のコマンド', () => {
  it('addAisle は末尾に足し、知らない項目を落とし、名前の空白を落とす', () => {
    const before = createEmptyScene()
    const after = ok(before, { type: 'addAisle', aisle: { ...ell, name: ' 主通路 ', memo: 'x' } as Aisle })
    expect(after.aisles).toEqual([{ ...ell, name: '主通路' }])
    expect(before.aisles).toEqual([])
  })

  it('addAisle は不正な通路と id の重複を断り、シーンを変えない', () => {
    const s = ok(createEmptyScene(), { type: 'addAisle', aisle: ell })
    expect(err(s, { type: 'addAisle', aisle: ell })).toMatch('重複')
    expect(err(s, { type: 'addAisle', aisle: aisle('aisle-2', [[0, 0]]) })).toMatch('2 つ以上')
    expect(s.aisles).toHaveLength(1)
  })

  it('updateAisle は名前と幅を変え、中心線は動かさない', () => {
    let s = ok(createEmptyScene(), { type: 'addAisle', aisle: ell })
    s = ok(s, { type: 'addAisle', aisle: aisle('aisle-2', [[0, 0], [0, 1000]]) })
    s = ok(s, { type: 'updateAisle', ids: ['aisle-1', 'aisle-2'], changes: { width: 2000 } })
    expect(s.aisles.map((a) => a.width)).toEqual([2000, 2000])
    expect(s.aisles[0]!.points).toEqual(ell.points)
    s = ok(s, { type: 'updateAisle', ids: ['aisle-1'], changes: { name: ' 主通路 ' } })
    expect(s.aisles.map((a) => a.name)).toEqual(['主通路', 'aisle-2'])
    expect(err(s, { type: 'updateAisle', ids: ['aisle-1'], changes: { width: -1 } })).toMatch('正の数')
    expect(err(s, { type: 'updateAisle', ids: ['aisle-1'], changes: {} })).toMatch('変える項目')
    expect(err(s, { type: 'updateAisle', ids: ['nope'], changes: { width: 1000 } })).toMatch('見つかりません')
    expect(err(s, { type: 'updateAisle', ids: [], changes: { width: 1000 } })).toMatch('対象の通路')
  })

  it('removeAisle は通路だけを消す', () => {
    let s = ok(createEmptyScene(), { type: 'addAisle', aisle: ell })
    s = ok(s, { type: 'removeAisle', ids: ['aisle-1'] })
    expect(s.aisles).toEqual([])
    expect(err(s, { type: 'removeAisle', ids: ['aisle-1'] })).toMatch('見つかりません')
  })
})

describe('ファイルの通路', () => {
  it('書き出して読み直すと通路も戻る', () => {
    const s = ok(createEmptyScene(), { type: 'addAisle', aisle: { ...ell, closed: true } })
    const r = parseScene(serializeScene(s))
    expect(r.ok && r.scene).toEqual(s)
  })

  it('版 2 のファイルは通路なしで読む', () => {
    const r = parseScene(JSON.stringify({ version: 2, background: null, site: null, equipment: [] }))
    expect(r.ok && r.scene).toEqual({ ...createEmptyScene(), version: SCENE_VERSION })
  })

  it('不正な通路を含むファイルは断る', () => {
    const r = parseScene(JSON.stringify({ ...createEmptyScene(), aisles: [{ ...ell, width: 0 }] }))
    expect(r.ok).toBe(false)
    const r2 = parseScene(JSON.stringify({ ...createEmptyScene(), aisles: null }))
    expect(!r2.ok && r2.error).toMatch('aisles')
  })
})

describe('頂点の編集', () => {
  const ring = aisle('aisle-2', [[0, 0], [4000, 0], [4000, 3000]], { closed: true })

  it('頂点を動かす・足す・消す（元の列は書き換えない）', () => {
    const pts = ell.points
    expect(moveAisleVertex(pts, 1, { x: 9000, y: 0 })).toEqual([{ x: 0, y: 0 }, { x: 9000, y: 0 }, { x: 10000, y: 5000 }])
    expect(insertAisleVertex(pts, 0, { x: 5000, y: 0 })).toEqual([{ x: 0, y: 0 }, { x: 5000, y: 0 }, { x: 10000, y: 0 }, { x: 10000, y: 5000 }])
    expect(removeAisleVertex(pts, 1)).toEqual([{ x: 0, y: 0 }, { x: 10000, y: 5000 }])
    expect(pts[1]).toEqual({ x: 10000, y: 0 })
  })

  it('周回の閉じる辺に足すと、最後に入る', () => {
    const mids = aisleMidpoints(ring)
    expect(mids).toEqual([{ x: 2000, y: 0 }, { x: 4000, y: 1500 }, { x: 2000, y: 1500 }])
    expect(insertAisleVertex(ring.points, 2, { x: 0, y: 3000 })).toEqual([{ x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 3000 }, { x: 0, y: 3000 }])
  })

  it('近い頂点を返す', () => {
    expect(aisleVertexAt(ell, { x: 9900, y: 50 }, 200)).toBe(1)
    expect(aisleVertexAt(ell, { x: 5000, y: 0 }, 200)).toBeNull()
  })

  it('setAislePoints は差し替えて確かめ直す。周回と名前・幅は変えない', () => {
    const s = ok(createEmptyScene(), { type: 'addAisle', aisle: ring })
    const s2 = ok(s, { type: 'setAislePoints', id: 'aisle-2', points: insertAisleVertex(ring.points, 2, { x: 0, y: 3000 }) })
    expect(s2.aisles[0]).toMatchObject({ closed: true, width: 1500, name: 'aisle-2' })
    expect(s2.aisles[0]!.points).toHaveLength(4)
    // 周回は 3 つ以上
    expect(err(s, { type: 'setAislePoints', id: 'aisle-2', points: removeAisleVertex(ring.points, 0) })).toMatch('3 つ以上')
    // 隣の頂点に重ねると断る
    expect(err(s, { type: 'setAislePoints', id: 'aisle-2', points: moveAisleVertex(ring.points, 1, { x: 0, y: 0 }) })).toMatch('同じ点')
    expect(err(s, { type: 'setAislePoints', id: 'nope', points: ring.points })).toMatch('見つかりません')
    expect(err(s, { type: 'setAislePoints', id: 'aisle-2', points: [{ x: 0, y: 0 }, { x: NaN, y: 0 }, { x: 1, y: 1 }] })).toMatch('数ではありません')
  })

  it('moveAisle は中心線ごとずらす', () => {
    let s = ok(createEmptyScene(), { type: 'addAisle', aisle: ell })
    s = ok(s, { type: 'addAisle', aisle: ring })
    const s2 = ok(s, { type: 'moveAisle', ids: ['aisle-1'], dx: 100, dy: -200 })
    expect(s2.aisles[0]!.points[2]).toEqual({ x: 10100, y: 4800 })
    expect(s2.aisles[1]).toBe(s.aisles[1])
    expect(err(s, { type: 'moveAisle', ids: ['aisle-1'], dx: Infinity, dy: 0 })).toMatch('数ではありません')
    expect(err(s, { type: 'moveAisle', ids: [], dx: 0, dy: 0 })).toMatch('ありません')
  })
})
