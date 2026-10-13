import { describe, expect, it } from 'vitest'
import type { Aisle } from './aisle'
import { buildRouteNet, pathLength, pointAlong, projectOnSegment, shortestPath } from './route'

const aisle = (id: string, points: [number, number][], closed = false): Aisle => ({
  id,
  name: id,
  points: points.map(([x, y]) => ({ x, y })),
  width: 1500,
  closed,
})

describe('projectOnSegment', () => {
  it('線分に下ろした点。端の外は端に寄せる', () => {
    expect(projectOnSegment({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toEqual({ t: 0.5, at: { x: 5, y: 0 }, d: 3 })
    expect(projectOnSegment({ x: -4, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 }).at).toEqual({ x: 0, y: 0 })
  })
})

describe('buildRouteNet と shortestPath', () => {
  it('交わる 2 本の通路は交点で乗り換えられる', () => {
    const { net, attach } = buildRouteNet(
      [aisle('a', [[0, 0], [10000, 0]]), aisle('b', [[5000, -5000], [5000, 5000]])],
      [{ x: 0, y: 0 }, { x: 5000, y: 5000 }],
    )
    const path = shortestPath(net, attach[0]!, attach[1]!)!
    expect(path).toEqual([{ x: 0, y: 0 }, { x: 5000, y: 0 }, { x: 5000, y: 5000 }])
    expect(pathLength(path)).toBe(10000)
  })

  it('端が他の通路の途中に接する（T 字）ところもつながる', () => {
    const { net, attach } = buildRouteNet(
      [aisle('a', [[0, 0], [10000, 0]]), aisle('b', [[4000, 0], [4000, 6000]])],
      [{ x: 10000, y: 0 }, { x: 4000, y: 6000 }],
    )
    expect(pathLength(shortestPath(net, attach[0]!, attach[1]!)!)).toBe(12000)
  })

  it('両方向に走れる。周回では短い向きを選ぶ', () => {
    const loop = aisle('loop', [[0, 0], [10000, 0], [10000, 4000], [0, 4000]], true)
    const { net, attach } = buildRouteNet([loop], [{ x: 0, y: 0 }, { x: 0, y: 4000 }])
    // 時計回りなら 24000 mm、反時計回り（閉じる辺）なら 4000 mm
    expect(pathLength(shortestPath(net, attach[0]!, attach[1]!)!)).toBe(4000)
    expect(pathLength(shortestPath(net, attach[1]!, attach[0]!)!)).toBe(4000)
  })

  it('一方通行の通路は頂点の順にだけ走る。帰りは別の道を探す', () => {
    // 上の辺を右へ、下の辺を左へ（時計回りの一方通行の周回）
    const loop = { ...aisle('loop', [[0, 0], [10000, 0], [10000, 4000], [0, 4000]], true), oneWay: true }
    const { net, attach } = buildRouteNet([loop], [{ x: 0, y: 0 }, { x: 0, y: 4000 }])
    expect(pathLength(shortestPath(net, attach[0]!, attach[1]!)!)).toBe(24000)
    expect(pathLength(shortestPath(net, attach[1]!, attach[0]!)!)).toBe(4000)
    // 逆向きには乗り継げない
    const one = { ...aisle('a', [[0, 0], [10000, 0]]), oneWay: true }
    const r = buildRouteNet([one], [{ x: 0, y: 0 }, { x: 10000, y: 0 }])
    expect(shortestPath(r.net, r.attach[0]!, r.attach[1]!)).not.toBeNull()
    expect(shortestPath(r.net, r.attach[1]!, r.attach[0]!)).toBeNull()
  })

  it('網の外の点は、いちばん近い中心線の上の点（乗り場）で乗る', () => {
    const { net, attach } = buildRouteNet([aisle('a', [[0, 0], [10000, 0]])], [{ x: 0, y: 0 }, { x: 7000, y: 2500 }])
    expect(net.nodes[attach[1]!]).toEqual({ x: 7000, y: 0 })
    expect(shortestPath(net, attach[0]!, attach[1]!)).toEqual([{ x: 0, y: 0 }, { x: 7000, y: 0 }])
  })

  it('離れた通路にはつながらない（null）', () => {
    const { net, attach } = buildRouteNet(
      [aisle('a', [[0, 0], [1000, 0]]), aisle('b', [[0, 5000], [1000, 5000]])],
      [{ x: 0, y: 0 }, { x: 1000, y: 5000 }],
    )
    expect(shortestPath(net, attach[0]!, attach[1]!)).toBeNull()
  })

  it('通路が無ければ乗り場も無い', () => {
    expect(buildRouteNet([], [{ x: 0, y: 0 }]).attach).toEqual([null])
  })
})

describe('pointAlong', () => {
  it('道を s 進んだ点と向き', () => {
    const path = [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 1000 }]
    expect(pointAlong(path, 500)).toEqual({ at: { x: 500, y: 0 }, angle: 0 })
    expect(pointAlong(path, 1500)).toEqual({ at: { x: 1000, y: 500 }, angle: Math.PI / 2 })
    expect(pointAlong(path, 9999).at).toEqual({ x: 1000, y: 1000 })
  })
})
