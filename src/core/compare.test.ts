import { describe, expect, it } from 'vitest'
import type { Aisle } from './aisle'
import { planMetrics, rectUnionArea, smallestIndexes } from './compare'
import { createEmptyScene, type Clearance, type Equipment, type Rotation, type Scene } from './scene'
import { rectSite } from './site'

const c0: Clearance = { top: 0, right: 0, bottom: 0, left: 0 }

// 左上 (x, y)、幅 w、奥行 d の設備
function eq(id: string, x: number, y: number, w: number, d: number, clearance = c0, rotation: Rotation = 0): Equipment {
  const turned = rotation === 90 || rotation === 270
  const fw = turned ? d : w
  const fh = turned ? w : d
  return { id, kind: 'molding-machine', name: id, x: x + fw / 2, y: y + fh / 2, width: w, depth: d, rotation, color: '#888888', clearance }
}

function scene(equipment: Equipment[], over: Partial<Scene> = {}): Scene {
  return { ...createEmptyScene(), equipment, ...over }
}

describe('rectUnionArea', () => {
  it('重なった所は 1 回だけ数える', () => {
    const a = { x: 0, y: 0, width: 100, height: 100 }
    expect(rectUnionArea([a])).toBe(10000)
    expect(rectUnionArea([a, a])).toBe(10000)
    expect(rectUnionArea([a, { x: 50, y: 50, width: 100, height: 100 }])).toBe(17500)
    // 接するだけ・離れている
    expect(rectUnionArea([a, { x: 100, y: 0, width: 100, height: 100 }, { x: 500, y: 500, width: 10, height: 10 }])).toBe(20100)
    // 十字
    expect(rectUnionArea([{ x: 0, y: 40, width: 100, height: 20 }, { x: 40, y: 0, width: 20, height: 100 }])).toBe(3600)
    expect(rectUnionArea([])).toBe(0)
  })
})

describe('planMetrics', () => {
  it('空のシーンは 0 と null', () => {
    expect(planMetrics(createEmptyScene())).toMatchObject({ siteArea: null, extent: null, bodyArea: 0, clearanceArea: 0, equipmentCount: 0 })
  })

  it('余白は重なりを 1 回だけ数え、他の設備の本体が入った所は本体に数える', () => {
    const cl = { top: 1000, right: 1000, bottom: 1000, left: 1000 }
    // 2000 × 1000 の設備を 2 台、本体のすき間 1000 で並べる: 余白が 1000 の幅で重なる
    const s = scene([eq('a', 0, 0, 2000, 1000, cl), eq('b', 3000, 0, 2000, 1000, cl)])
    const m = planMetrics(s)
    expect(m.bodyArea).toBe(4_000_000)
    // 余白まで含めた和集合は 7000 × 3000、本体を引く
    expect(m.clearanceArea).toBe(21_000_000 - 4_000_000)
    expect(m.extent).toEqual({ x: -1000, y: -1000, width: 7000, height: 3000 })
    expect(m.intrusions).toBe(0)
    // 寄せて本体が相手の余白に入ると、入った所は余白から外れる
    const t = scene([eq('a', 0, 0, 2000, 1000, cl), eq('b', 2500, 0, 2000, 1000, cl)])
    const n = planMetrics(t)
    expect(n.clearanceArea).toBe(6500 * 3000 - 4_000_000)
    expect(n.intrusions).toBe(2)
  })

  it('回した設備の余白も向きどおりに数える', () => {
    const m = planMetrics(scene([eq('a', 0, 0, 2000, 1000, { top: 500, right: 0, bottom: 0, left: 0 }, 90)]))
    // 90 度回すと上の余白は右へ。本体は 1000 × 2000
    expect(m.clearanceArea).toBe(500 * 2000)
    expect(m.extent).toEqual({ x: 0, y: 0, width: 1500, height: 2000 })
  })

  it('外接には通路の帯も入る。敷地の面積、はみ出し、重なりも数える', () => {
    const aisle: Aisle = { id: 'p', name: 'p', points: [{ x: 0, y: 5000 }, { x: 8000, y: 5000 }], width: 1500, closed: false }
    const s = scene([eq('a', 0, 0, 2000, 1000), eq('b', 1000, 0, 2000, 1000), eq('c', 9000, 0, 2000, 1000)], {
      aisles: [aisle],
      site: rectSite(0, 0, 10000, 8000),
    })
    const m = planMetrics(s)
    expect(m.siteArea).toBe(80_000_000)
    expect(m.extent).toEqual({ x: 0, y: 0, width: 11000, height: 5750 })
    expect(m.bodyArea).toBe(3000 * 1000 + 2000 * 1000)
    expect(m.overlaps).toBe(1)
    expect(m.outside).toBe(1)
    expect(m.aisleLength).toBe(8000)
  })
})

describe('smallestIndexes', () => {
  it('いちばん小さい値の番号。null は除き、比べる相手が無ければ印を付けない', () => {
    expect(smallestIndexes([3, 1, 2, 1])).toEqual([1, 3])
    expect(smallestIndexes([null, 5, 7])).toEqual([1])
    expect(smallestIndexes([null, 5])).toEqual([])
    expect(smallestIndexes([])).toEqual([])
  })
})
