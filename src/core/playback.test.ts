import { describe, expect, it } from 'vitest'
import type { Aisle } from './aisle'
import type { Link } from './flow'
import { pathLength } from './route'
import { applyCommand } from './commands'
import { createHistory, execute, undo } from './history'
import { DEFAULT_FLOW_PARAMS, agvUtilization, flowParams, flowView, formatClock, initialFlow, prepareFlow, stepFlow, type FlowParams } from './playback'
import { DEFAULT_FLOW_SETTINGS, createEmptyScene, type Equipment, type Scene } from './scene'
import { parseScene, serializeScene } from './sceneFile'

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
const P: FlowParams = { cycleTime: 1, stockerCapacity: 3, agvSpeed: 1000, agvHandlingTime: 2, agvCount: 1, transferSpeed: 1e9 }

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

describe('一方通行の通路', () => {
  // 出入り口 (0, 3000) から右へ行き、下を回って左へ戻る時計回りの周回
  const loop: Aisle = {
    id: 'a',
    name: 'a',
    points: [{ x: 0, y: 3000 }, { x: 10000, y: 3000 }, { x: 10000, y: 6000 }, { x: 0, y: 6000 }],
    width: 1500,
    closed: true,
    oneWay: true,
  }

  it('帰りは行きの逆でなく、向きに沿った別の道', () => {
    const m = prepareFlow(cell(undefined, [loop]))
    expect(m.routes.s1).toEqual([{ x: 0, y: 3000 }, { x: 4000, y: 3000 }])
    // s2 の乗り場 (6000, 3000) を通り、右へ回って出入り口へ
    expect(m.returns.s1).toEqual([{ x: 4000, y: 3000 }, { x: 6000, y: 3000 }, { x: 10000, y: 3000 }, { x: 10000, y: 6000 }, { x: 0, y: 6000 }, { x: 0, y: 3000 }])
    expect(m.warnings).toEqual([])
  })

  it('帰りの時間は帰り道の長さで決まり、帰りの AGV は帰り道の向きを向く', () => {
    const m = prepareFlow(cell(undefined, [loop]))
    // 3 秒で s1 が満杯 → 行き 4 秒 → 積み替え 2 秒 → 帰り 22 秒
    let st = stepFlow(m, { ...P, stockerCapacity: 3 }, initialFlow(m), 3 + 4 + 2 + 1)
    expect(st.agvs[0]!.phase).toBe('returning')
    const v = flowView(m, st).agvs[0]!
    expect(v.loaded).toBe(true)
    expect(v.angle).toBeCloseTo(0)
    st = stepFlow(m, P, st, 22)
    expect(st.carts).toBe(1)
  })

  it('帰れない向きなら知らせ、そのストッカーには行かない', () => {
    const one: Aisle = { id: 'a', name: 'a', points: [{ x: 0, y: 3000 }, { x: 10000, y: 3000 }], width: 1500, closed: false, oneWay: true }
    const { model, state } = run(cell(undefined, [one]), 20)
    expect(model.returns.s1).toBeNull()
    expect(model.warnings).toContain('s1 から AGV の出入り口へ帰る通路がありません（一方通行の向きを確かめてください）')
    expect(state.agvs[0]!.phase).toBe('idle')
    expect(state.carts).toBe(0)
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
    expect(s.agvs[0]).toMatchObject({ phase: 'going', stocker: 's1' })
    s = stepFlow(model, P, s, 4.1) // 7.2 秒
    expect(s.agvs[0]).toMatchObject({ phase: 'loading', stocker: 's1' })
    expect(flowView(model, s).agvs[0]!.at).toEqual({ x: 4000, y: 3000 })
    s = stepFlow(model, P, s, 2) // 9.2 秒: 替え終わって戻る途中
    expect(s.agvs[0]!.phase).toBe('returning')
    expect(s.stockers.s1).toMatchObject({ count: 0, full: false })
    const v = flowView(model, s)
    expect(v.agvs[0]!.loaded).toBe(true)
    expect(v.agvs[0]!.at.x).toBeLessThan(4000)
    s = stepFlow(model, P, s, 4) // 13.2 秒: 出入り口に着いた。6 秒目に満杯になった s2 へ続けて向かう
    expect(s.carts).toBe(1)
    expect(s.agvs[0]).toMatchObject({ phase: 'going', stocker: 's2' })
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

  it('AGV が 2 台なら、2 か所の呼び出しに同時に向かい、稼働率を数える', () => {
    const slow: FlowParams = { ...P, agvSpeed: 400, agvCount: 2 } // 片道 10 秒
    const model = prepareFlow(cell())
    let s = stepFlow(model, slow, initialFlow(model, slow), 6.5)
    // 3 秒で s1、6 秒で s2 が満杯。1 台目は s1、2 台目は s2 へ
    expect(s.agvs).toHaveLength(2)
    expect(s.agvs[0]).toMatchObject({ phase: 'going', stocker: 's1' })
    expect(s.agvs[1]).toMatchObject({ phase: 'going', stocker: 's2' })
    expect(s.requests).toEqual([])
    expect(flowView(model, s).agvs).toHaveLength(2)
    // 1 台目は 3 秒から動き、2 台目は 6 秒から動いた
    const [u1, u2] = agvUtilization(s)
    expect(u1).toBeCloseTo(3.5 / 6.5, 5)
    expect(u2).toBeCloseTo(0.5 / 6.5, 5)
  })

  it('戻る途中の AGV より、空いている AGV が先に呼び出しを受ける', () => {
    const two: FlowParams = { ...P, agvCount: 2 }
    const model = prepareFlow(cell())
    const st = initialFlow(model, two)
    // 1 台目はあと 100 mm で出入り口に戻る。2 台目は空いている。s2 が呼んでいる
    st.agvs[0] = { phase: 'returning', stocker: 's1', s: pathLength(model.returns.s1!) - 100 }
    st.requests = ['s2']
    const s = stepFlow(model, two, st, 0.25)
    expect(s.agvs[1]).toMatchObject({ phase: 'going', stocker: 's2' })
    expect(s.agvs[0]!.phase).toBe('idle')
    expect(s.carts).toBe(1)
  })

  it('AGV 1 台と 2 台で、満杯で待つ時間が変わる', () => {
    const slow: FlowParams = { ...P, agvSpeed: 400 }
    const model = prepareFlow(cell())
    // s1 は片道 10 秒、s2 は片道 15 秒。1 台なら s1 から戻る 25 秒まで s2 は待ち、2 台なら 6 秒から s2 へ向かい 38 秒で戻る
    const one = stepFlow(model, slow, initialFlow(model, slow), 45)
    const two = stepFlow(model, { ...slow, agvCount: 2 }, initialFlow(model, { ...slow, agvCount: 2 }), 45)
    expect(one.carts).toBe(1)
    expect(two.carts).toBeGreaterThanOrEqual(2)
  })

  it('時刻 0 の稼働率は 0', () => {
    const model = prepareFlow(cell())
    expect(agvUtilization(initialFlow(model, { ...P, agvCount: 3 }))).toEqual([0, 0, 0])
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
    const loading = s.agvs[0]!.phase === 'returning' ? DEFAULT_FLOW_PARAMS.stockerCapacity : 0
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

describe('流れの再生の数値（シーンの flow と setFlow）', () => {
  const ok = (r: ReturnType<typeof applyCommand>) => {
    if (!r.ok) throw new Error(r.error)
    return r.scene
  }
  const err = (r: ReturnType<typeof applyCommand>) => (r.ok ? '' : r.error)

  it('新しいシーンは架空の目安を持ち、flowParams で移る速さを足す', () => {
    const s = createEmptyScene()
    expect(s.flow).toEqual(DEFAULT_FLOW_SETTINGS)
    expect(flowParams(s.flow)).toEqual(DEFAULT_FLOW_PARAMS)
  })

  it('書いた数値だけ変える。元のシーンは変えない', () => {
    const s = createEmptyScene()
    const t = ok(applyCommand(s, { type: 'setFlow', changes: { cycleTime: 12.5, agvSpeed: 1500 } }))
    expect(t.flow).toEqual({ ...DEFAULT_FLOW_SETTINGS, cycleTime: 12.5, agvSpeed: 1500 })
    expect(s.flow).toEqual(DEFAULT_FLOW_SETTINGS)
  })

  it('範囲の外・整数でない容量・空の変更は理由つきで断る', () => {
    const s = createEmptyScene()
    const set = (changes: Record<string, unknown>) => err(applyCommand(s, { type: 'setFlow', changes } as never))
    expect(set({ cycleTime: 0 })).toMatch('サイクル時間')
    expect(set({ cycleTime: 0.5 })).toMatch('1 以上')
    expect(set({ stockerCapacity: 2.5 })).toMatch('整数')
    expect(set({ agvSpeed: -1 })).toMatch('AGV の速さ')
    expect(set({ agvHandlingTime: Number.NaN })).toMatch('入れ替え')
    expect(set({ cycleTime: '30' })).toMatch('サイクル時間')
    expect(set({ agvCount: 0 })).toMatch('AGV の台数')
    expect(set({ agvCount: 1.5 })).toMatch('整数')
    expect(set({ agvCount: 21 })).toMatch('20 以下')
    expect(set({})).toMatch('ありません')
    expect(ok(applyCommand(s, { type: 'setFlow', changes: { agvHandlingTime: 0 } })).flow.agvHandlingTime).toBe(0)
  })

  it('loadScene で flow の一部しか書かなければ、残りは架空の目安で埋める', () => {
    const t = ok(applyCommand(createEmptyScene(), { type: 'loadScene', scene: { ...createEmptyScene(), flow: { cycleTime: 20 } } } as never))
    expect(t.flow).toEqual({ ...DEFAULT_FLOW_SETTINGS, cycleTime: 20 })
  })

  it('元に戻すで前の数値に戻る', () => {
    const h0 = createHistory(createEmptyScene())
    const r = execute(h0, { type: 'setFlow', changes: { stockerCapacity: 40 } })
    expect(r.ok && r.history.present.flow.stockerCapacity).toBe(40)
    expect(undo(r.history).present.flow.stockerCapacity).toBe(20)
  })

  it('ファイルに書いて読むと数値が残る。版 5 のファイルは架空の目安で読む', () => {
    const s = ok(applyCommand(createEmptyScene(), { type: 'setFlow', changes: { cycleTime: 45, stockerCapacity: 12 } }))
    const back = parseScene(serializeScene(s))
    expect(back.ok && back.scene.flow).toEqual(s.flow)
    const v5 = parseScene(JSON.stringify({ version: 5, background: null, site: null, equipment: [], aisles: [], links: [] }))
    expect(v5.ok && v5.scene.flow).toEqual(DEFAULT_FLOW_SETTINGS)
    const bad = parseScene(JSON.stringify({ ...s, flow: { ...s.flow, stockerCapacity: 0 } }))
    expect(bad.ok ? '' : bad.error).toMatch('容量')
  })

  it('数値で再生が変わる: 容量を倍にすると、同じ時間で運び出す台車が減る', () => {
    const base = { ...P, agvSpeed: 1e9, agvHandlingTime: 0.5 }
    const a = run(cell(), 60, base).state
    const b = run(cell(), 60, { ...base, stockerCapacity: 6 }).state
    expect(a.produced).toBe(b.produced)
    expect(b.carts).toBeLessThan(a.carts)
  })
})
