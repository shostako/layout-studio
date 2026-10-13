import { describe, expect, it } from 'vitest'
import type { Aisle } from './aisle'
import type { Link } from './flow'
import { DEFAULT_FLOW_PARAMS, flowView, formatClock, initialFlow, prepareFlow, stepFlow, type FlowParams } from './playback'
import { createEmptyScene, type Equipment, type Scene } from './scene'

function eq(id: string, kind: string, x: number, y = 0): Equipment {
  return { id, kind, name: id, x, y, width: 1000, depth: 1000, rotation: 0, color: '#888', clearance: { top: 0, right: 0, bottom: 0, left: 0 } }
}

// 成形機 m → 重量計 w → ストッカー s1・s2。通路は y = 3000 を左右に走り、出入り口は x = 0
function cell(links?: Link[], aisles?: Aisle[]): Scene {
  return {
    ...createEmptyScene(),
    equipment: [eq('m', 'molding-machine', 0), eq('w', 'weighing-scale', 2000), eq('s1', 'cart-stocker', 4000), eq('s2', 'cart-stocker', 6000)],
    links: links ?? [
      { from: 'm', to: 'w' },
      { from: 'w', to: 's1' },
      { from: 'w', to: 's2' },
    ],
    aisles: aisles ?? [{ id: 'a', name: 'a', points: [{ x: 0, y: 3000 }, { x: 10000, y: 3000 }], width: 1500, closed: false }],
  }
}

// 計算しやすい値: 1 秒に 1 個、ストッカーは 3 個で満杯、移る速さ・AGV は十分速い
const P: FlowParams = { cycleTime: 1, stockerCapacity: 3, agvSpeed: 1000, agvHandlingTime: 2, transferSpeed: 1e9 }

const run = (scene: Scene, seconds: number, params = P) => {
  const model = prepareFlow(scene)
  return { model, state: stepFlow(model, params, initialFlow(model), seconds) }
}

describe('prepareFlow', () => {
  it('生まれる設備・着くストッカー・AGV の道', () => {
    const m = prepareFlow(cell())
    expect(m.sources).toEqual(['m'])
    expect(m.stockers).toEqual(['s1', 's2'])
    expect(m.home).toEqual({ x: 0, y: 3000 })
    expect(m.docks.s2).toEqual({ x: 6000, y: 3000 })
    expect(m.routes.s1).toEqual([{ x: 0, y: 3000 }, { x: 4000, y: 3000 }])
    expect(m.warnings).toEqual([])
  })

  it('つなぎ・ストッカー・通路が無ければ知らせる', () => {
    expect(prepareFlow(cell([])).warnings[0]).toMatch('成形品の生まれる設備がありません')
    expect(prepareFlow(cell([{ from: 'm', to: 'w' }])).warnings).toEqual(['流れの先に台車ストッカーがありません'])
    const m = prepareFlow(cell(undefined, []))
    expect(m.warnings[0]).toMatch('AGV の通路がありません')
    expect(m.routes.s1).toBeNull()
  })

  it('出入り口の通路から離れたストッカーは、つながっていないと知らせる', () => {
    const aisles: Aisle[] = [
      { id: 'a', name: 'a', points: [{ x: 0, y: 3000 }, { x: 4000, y: 3000 }], width: 1500, closed: false },
      { id: 'b', name: 'b', points: [{ x: 6000, y: -3000 }, { x: 8000, y: -3000 }], width: 1500, closed: false },
    ]
    const m = prepareFlow({ ...cell(), equipment: [...cell().equipment.slice(0, 3), eq('s2', 'cart-stocker', 7000, -2000)] , aisles })
    expect(m.routes.s1).not.toBeNull()
    expect(m.routes.s2).toBeNull()
    expect(m.warnings).toEqual(['s2 へ、AGV の出入り口から通路がつながっていません'])
  })
})

describe('stepFlow', () => {
  it('サイクル時間ごとに 1 個生まれ、ストッカーに溜まる。元の状態は変えない', () => {
    const model = prepareFlow(cell())
    const s0 = initialFlow(model)
    const s = stepFlow(model, P, s0, 2.5)
    expect(s.produced).toBe(2)
    expect(s.stockers.s1!.count).toBe(2)
    expect(s0.produced).toBe(0)
    expect(s0.stockers.s1!.count).toBe(0)
  })

  it('ストッカーへの分岐は、満杯で予備へ切り替える（交互にしない）', () => {
    const { state } = run(cell(), 4.5)
    // 3 個で s1 が満杯、4 個目から s2
    expect(state.stockers.s1).toMatchObject({ count: 3, full: true })
    expect(state.stockers.s2!.count).toBe(1)
  })

  it('ストッカー以外への分岐は交互に振り分ける', () => {
    const scene: Scene = {
      ...createEmptyScene(),
      equipment: [eq('m', 'molding-machine', 0), eq('d1', 'degating-machine', 2000), eq('d2', 'degating-machine', 2000, 2000)],
      links: [
        { from: 'm', to: 'd1' },
        { from: 'm', to: 'd2' },
      ],
    }
    const model = prepareFlow(scene)
    let s = initialFlow(model)
    const seen: string[] = []
    for (let i = 0; i < 4; i++) {
      s = stepFlow(model, { ...P, transferSpeed: 1 }, s, 1)
      seen.push(s.parts[s.parts.length - 1]!.to)
    }
    expect(seen).toEqual(['d1', 'd2', 'd1', 'd2'])
  })

  it('満杯で AGV を呼び、通路を往復して台車を替える', () => {
    // 3 秒目に s1 が満杯 → AGV は 4000 mm を 4 秒で行き、2 秒で替え、4 秒で戻る
    const model = prepareFlow(cell())
    let s = stepFlow(model, P, initialFlow(model), 3.1)
    expect(s.agv).toMatchObject({ phase: 'going', stocker: 's1' })
    s = stepFlow(model, P, s, 4.1) // 7.2 秒
    expect(s.agv).toMatchObject({ phase: 'loading', stocker: 's1' })
    expect(flowView(model, s).agv!.at).toEqual({ x: 4000, y: 3000 })
    s = stepFlow(model, P, s, 2) // 9.2 秒: 替え終わって戻る途中
    expect(s.agv.phase).toBe('returning')
    expect(s.stockers.s1).toMatchObject({ count: 0, full: false })
    const v = flowView(model, s)
    expect(v.agv!.loaded).toBe(true)
    expect(v.agv!.at.x).toBeLessThan(4000)
    s = stepFlow(model, P, s, 4) // 13.2 秒: 出入り口に着いた。6 秒目に満杯になった s2 へ続けて向かう
    expect(s.carts).toBe(1)
    expect(s.agv).toMatchObject({ phase: 'going', stocker: 's2' })
  })

  it('どこも受けられなければ、手前の設備で待たせ、空いたら送る', () => {
    // 通路が無いので AGV が来ない。6 個で 2 台とも満杯、7 個目から重量計で待つ
    const { state } = run(cell(undefined, []), 8.5)
    expect(state.stockers.s1!.full && state.stockers.s2!.full).toBe(true)
    expect(state.held.w).toBe(2)
    expect(state.requests).toEqual(['s1', 's2'])
  })

  it('AGV が台車を替えると、待っていた成形品から先に送る', () => {
    const slow: FlowParams = { ...P, agvSpeed: 400 } // 片道 10 秒
    const model = prepareFlow(cell())
    let s = stepFlow(model, slow, initialFlow(model), 9.5)
    // s1 は 3 秒で満杯、s2 は 6 秒で満杯、7〜9 個目は待つ
    expect(s.held.w).toBe(3)
    s = stepFlow(model, slow, s, 6) // 15.5 秒: 3 + 10 + 2 = 15 秒で s1 が空く
    // 待っていた 9 個のうち先の 3 個で s1 がまた満杯になり、残り 6 個が待つ
    expect(s.produced).toBe(15)
    expect(s.stockers.s1).toMatchObject({ count: 3, full: true })
    expect(s.held.w).toBe(6)
    expect(s.requests).toEqual(['s2', 's1'])
  })

  it('次の工程の無い設備（ストッカー以外）に着いたら終わり', () => {
    const { state } = run(cell([{ from: 'm', to: 'w' }]), 3.5)
    expect(state.finished).toBe(3)
  })

  it('既定の値でも 1 時間回して数が合う', () => {
    const model = prepareFlow(cell())
    const s = stepFlow(model, DEFAULT_FLOW_PARAMS, initialFlow(model), 3600)
    const inStock = s.stockers.s1!.count + s.stockers.s2!.count + s.stockers.s1!.incoming + s.stockers.s2!.incoming
    const held = Object.values(s.held).reduce((a, b) => a + b, 0)
    const moving = s.parts.filter((p) => !p.to.startsWith('s')).length
    const loading = s.agv.phase === 'returning' ? DEFAULT_FLOW_PARAMS.stockerCapacity : 0
    expect(s.produced).toBe(120)
    expect(s.carts * DEFAULT_FLOW_PARAMS.stockerCapacity + loading + inStock + held + moving).toBe(s.produced)
  })
})

describe('formatClock', () => {
  it('m:ss と h:mm:ss', () => {
    expect(formatClock(65.7)).toBe('1:05')
    expect(formatClock(3725)).toBe('1:02:05')
  })
})
