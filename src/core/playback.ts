// 流れの再生: 成形品の発生、つなぎに沿った移動、ストッカーに溜まる、満杯で予備へ切り替え、AGV が通路を通って運び出す。
// シーンから再生の筋書き（prepareFlow）を作り、時刻を進める（stepFlow）。どちらも純関数で、DOM に触らない。
// 再生の状態はシーンに入れず、コマンドにもしない（表示範囲と同じく、案の中身ではない）。
//
// 決まり（DECISIONS.md）:
// - 成形品が生まれるのは、次の工程があって前の工程の無い設備（ふつうは成形機）。サイクル時間ごとに 1 個。
// - 途中の設備では止まらず、すぐ次の工程へ送る（処理の時間は持たない）。次の工程の無い設備（ストッカー以外）に着いたら終わり。
// - 分岐: 行き先がどれも台車ストッカーなら、今のストッカーが満杯になるまで入れ、満杯で次（予備）へ切り替える。
//   それ以外は交互に振り分ける（受けられないストッカーは飛ばす）。どこも受けられなければ、その設備で待たせる。
// - ストッカーは容量の数で満杯。満杯になったら AGV を呼び、来るまで受けない。
// - AGV は 1 台。通路の最初の頂点（いちばん先に描いた通路の始点）を出入り口にし、呼ばれた順にストッカーへ行き、
//   積み替えの時間のあいだ止まって満杯の台車を空の台車と替え、出入り口へ運び出す。通路は両方向に走れる。
//   ストッカーへは、いちばん近い中心線の上の点（乗り場）まで行く。

import { linkSegment } from './flow'
import { buildRouteNet, pathLength, pointAlong, shortestPath } from './route'
import { DEFAULT_FLOW_SETTINGS, type FlowSettings, type Scene } from './scene'
import type { Point } from './viewport'

export const STOCKER_KIND = 'cart-stocker'

// サイクル・容量・AGV の速さと入れ替えの時間はシーンの flow（案ごとに画面で変える）。移る速さは見せ方の値で固定
export type FlowParams = FlowSettings & {
  transferSpeed: number // 成形品が設備から設備へ移る速さ（mm/秒）
}

// 成形品が移る速さ（架空の目安）
export const TRANSFER_SPEED = 500

export function flowParams(settings: FlowSettings): FlowParams {
  return { ...settings, transferSpeed: TRANSFER_SPEED }
}

export const DEFAULT_FLOW_PARAMS: FlowParams = flowParams(DEFAULT_FLOW_SETTINGS)

export type FlowModel = {
  sources: string[] // 成形品が生まれる設備
  next: Record<string, string[]> // 次の工程（つなぎの順）
  stockers: string[] // 流れが着く台車ストッカー
  isStocker: Record<string, boolean>
  segments: Record<string, [Point, Point]> // つなぎ（'from>to'）の線
  home: Point | null // AGV の出入り口
  docks: Record<string, Point> // ストッカーの乗り場（通路の上）
  routes: Record<string, Point[] | null> // 出入り口からストッカーの乗り場への道。つながっていなければ null
  warnings: string[]
}

export type FlowPart = { id: number; from: string; to: string; s: number; length: number }
export type StockerState = { count: number; incoming: number; full: boolean }
export type AgvState =
  | { phase: 'idle' }
  | { phase: 'going'; stocker: string; s: number }
  | { phase: 'returning'; stocker: string; s: number }
  | { phase: 'loading'; stocker: string; left: number }

export type FlowState = {
  time: number // 秒
  nextPartId: number
  timers: Record<string, number> // 成形機ごとの、前のショットからの時間
  parts: FlowPart[] // つなぎの上を移っている成形品
  held: Record<string, number> // 行き先が受けられず、設備で待っている数
  cursor: Record<string, number> // 分岐の、今の（次の）行き先の番号
  stockers: Record<string, StockerState>
  requests: string[] // AGV を呼んでいるストッカー（呼んだ順）
  agv: AgvState
  produced: number // 生まれた成形品の数
  finished: number // ストッカー以外の終わりに着いた数
  carts: number // 運び出した台車の数
}

const linkKey = (from: string, to: string) => `${from}>${to}`
// 時刻を進める刻み（秒）。大きく進めるときはこれに分ける
const MAX_STEP = 0.25

// シーンから再生の筋書きを作る
export function prepareFlow(scene: Scene): FlowModel {
  const byId = new Map(scene.equipment.map((e) => [e.id, e]))
  const next: Record<string, string[]> = {}
  const hasPrev = new Set<string>()
  const segments: Record<string, [Point, Point]> = {}
  for (const l of scene.links) {
    const a = byId.get(l.from)
    const b = byId.get(l.to)
    if (!a || !b) continue
    ;(next[l.from] ??= []).push(l.to)
    hasPrev.add(l.to)
    segments[linkKey(l.from, l.to)] = linkSegment(a, b)
  }
  const isStocker: Record<string, boolean> = {}
  for (const e of scene.equipment) isStocker[e.id] = e.kind === STOCKER_KIND
  // ストッカーから先へは成形品を送らない（台車は AGV が運ぶ）
  const sources = scene.equipment.filter((e) => next[e.id]?.length && !hasPrev.has(e.id) && !isStocker[e.id]).map((e) => e.id)
  // 生まれた所からたどって着くストッカー
  const reached = new Set<string>()
  const stack = [...sources]
  while (stack.length) {
    const id = stack.pop()!
    if (reached.has(id)) continue
    reached.add(id)
    if (!isStocker[id]) stack.push(...(next[id] ?? []))
  }
  const stockers = scene.equipment.filter((e) => isStocker[e.id] && reached.has(e.id)).map((e) => e.id)

  const warnings: string[] = []
  const name = (id: string) => byId.get(id)?.name ?? id
  if (sources.length === 0) warnings.push('成形品の生まれる設備がありません。「工程のつなぎ」で成形機から先をつないでください')
  else if (stockers.length === 0) warnings.push('流れの先に台車ストッカーがありません')

  let home: Point | null = null
  const docks: Record<string, Point> = {}
  const routes: Record<string, Point[] | null> = {}
  const first = scene.aisles[0]
  if (stockers.length > 0) {
    if (!first) {
      warnings.push('AGV の通路がありません。満杯の台車を運び出せません')
      for (const id of stockers) routes[id] = null
    } else {
      home = { ...first.points[0]! }
      const centers = stockers.map((id) => ({ x: byId.get(id)!.x, y: byId.get(id)!.y }))
      const { net, attach } = buildRouteNet(scene.aisles, [home, ...centers])
      const h = attach[0]!
      stockers.forEach((id, i) => {
        const n = attach[i + 1]!
        docks[id] = net.nodes[n]!
        routes[id] = h !== null && n !== null ? shortestPath(net, h, n) : null
        if (!routes[id]) warnings.push(`${name(id)} へ、AGV の出入り口から通路がつながっていません`)
      })
    }
  }
  return { sources, next, stockers, isStocker, segments, home, docks, routes, warnings }
}

export function initialFlow(model: FlowModel): FlowState {
  return {
    time: 0,
    nextPartId: 1,
    timers: Object.fromEntries(model.sources.map((id) => [id, 0])),
    parts: [],
    held: {},
    cursor: {},
    stockers: Object.fromEntries(model.stockers.map((id) => [id, { count: 0, incoming: 0, full: false }])),
    requests: [],
    agv: { phase: 'idle' },
    produced: 0,
    finished: 0,
    carts: 0,
  }
}

// 行き先が今、成形品を受けられるか（ストッカーだけが断る）
function accepts(model: FlowModel, params: FlowParams, st: FlowState, id: string): boolean {
  if (!model.isStocker[id]) return true
  const s = st.stockers[id]
  if (!s) return false
  return !s.full && s.count + s.incoming < params.stockerCapacity
}

// 設備 id から次へ 1 個送る。carry はつなぎの上をもう進んだ長さ（mm）。送れたら true（送れなければ何も変えない）
function dispatch(model: FlowModel, params: FlowParams, st: FlowState, id: string, carry = 0): boolean {
  const outs = model.next[id] ?? []
  const n = outs.length
  const allStockers = outs.every((o) => model.isStocker[o])
  const cur = st.cursor[id] ?? 0
  let pick = -1
  for (let k = 0; k < n; k++) {
    const i = (cur + k) % n
    if (accepts(model, params, st, outs[i]!)) {
      pick = i
      break
    }
  }
  if (pick < 0) return false
  // ストッカーへの分岐は満杯まで同じ所へ入れ、ほかは交互に振り分ける
  st.cursor[id] = allStockers ? pick : (pick + 1) % n
  const to = outs[pick]!
  const seg = model.segments[linkKey(id, to)]!
  const length = Math.max(1, Math.hypot(seg[1].x - seg[0].x, seg[1].y - seg[0].y))
  st.parts.push({ id: st.nextPartId++, from: id, to, s: carry, length })
  if (model.isStocker[to]) st.stockers[to]!.incoming++
  return true
}

// 設備 id に成形品が 1 個着いた（または生まれた）。carry は着いてから（生まれてから）この刻みのうちに進めた長さ（mm）
function arrive(model: FlowModel, params: FlowParams, st: FlowState, id: string, carry: number): void {
  if (model.isStocker[id]) {
    const s = st.stockers[id]!
    s.incoming--
    s.count++
    if (s.count >= params.stockerCapacity && !s.full) {
      s.full = true
      st.requests.push(id)
    }
    return
  }
  if (!(model.next[id]?.length)) {
    st.finished++
    return
  }
  if ((st.held[id] ?? 0) > 0 || !dispatch(model, params, st, id, carry)) st.held[id] = (st.held[id] ?? 0) + 1
}

function step(model: FlowModel, params: FlowParams, st: FlowState, dt: number): void {
  st.time += dt
  // 待っている成形品を送れるだけ送る
  for (const id of Object.keys(st.held)) {
    while ((st.held[id] ?? 0) > 0 && dispatch(model, params, st, id)) st.held[id]!--
    if (st.held[id] === 0) delete st.held[id]
  }
  // つなぎの上を進める
  for (const p of st.parts) p.s += params.transferSpeed * dt
  // 成形。生まれてから刻みの終わりまでの分だけ、もう進んでいる
  for (const id of model.sources) {
    st.timers[id] = (st.timers[id] ?? 0) + dt
    while (st.timers[id]! >= params.cycleTime) {
      st.timers[id]! -= params.cycleTime
      st.produced++
      arrive(model, params, st, id, st.timers[id]! * params.transferSpeed)
    }
  }
  // 着いたものを次へ送る。途中の設備では止まらないので、余った長さは次のつなぎで進める（輪は無いので終わる）
  for (;;) {
    const arrived = st.parts.filter((p) => p.s >= p.length)
    if (arrived.length === 0) break
    st.parts = st.parts.filter((p) => p.s < p.length)
    for (const p of arrived) arrive(model, params, st, p.to, p.s - p.length)
  }
  // AGV
  let left = dt
  while (left > 0) {
    const agv = st.agv
    if (agv.phase === 'idle') {
      const k = st.requests.findIndex((id) => model.routes[id])
      if (k < 0) break
      const [id] = st.requests.splice(k, 1)
      st.agv = { phase: 'going', stocker: id!, s: 0 }
    } else if (agv.phase === 'going' || agv.phase === 'returning') {
      const len = pathLength(model.routes[agv.stocker]!)
      const need = (len - agv.s) / params.agvSpeed
      if (need > left) {
        agv.s += params.agvSpeed * left
        left = 0
      } else {
        left -= need
        if (agv.phase === 'going') st.agv = { phase: 'loading', stocker: agv.stocker, left: params.agvHandlingTime }
        else {
          st.carts++
          st.agv = { phase: 'idle' }
        }
      }
    } else if (agv.phase === 'loading') {
      if (agv.left > left) {
        agv.left -= left
        left = 0
      } else {
        left -= agv.left
        // 満杯の台車を空の台車と替えた。ストッカーはまた受けられる
        const s = st.stockers[agv.stocker]!
        s.count = 0
        s.full = false
        st.agv = { phase: 'returning', stocker: agv.stocker, s: 0 }
      }
    }
  }
}

// 時刻を dt 秒進めた状態。元の状態は変えない
export function stepFlow(model: FlowModel, params: FlowParams, state: FlowState, dt: number): FlowState {
  const st = structuredClone(state)
  let left = dt
  while (left > 1e-9) {
    const d = Math.min(MAX_STEP, left)
    step(model, params, st, d)
    left -= d
  }
  return st
}

export type FlowView = {
  parts: Point[]
  agv: { at: Point; angle: number; loaded: boolean } | null
}

// 描く位置: 移っている成形品と AGV
export function flowView(model: FlowModel, state: FlowState): FlowView {
  const parts = state.parts.map((p) => {
    const [a, b] = model.segments[linkKey(p.from, p.to)]!
    const t = Math.min(1, p.s / p.length)
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
  })
  let agv: FlowView['agv'] = null
  const a = state.agv
  if (model.home) {
    if (a.phase === 'idle') {
      const first = Object.values(model.routes).find((r) => r && r.length > 1)
      agv = { at: model.home, angle: first ? pointAlong(first, 0).angle : 0, loaded: false }
    } else {
      const route = model.routes[a.stocker]!
      const len = pathLength(route)
      if (a.phase === 'going') agv = { ...pointAlong(route, a.s), loaded: false }
      else if (a.phase === 'loading') agv = { ...pointAlong(route, len), loaded: false }
      else {
        const p = pointAlong(route, len - a.s)
        agv = { at: p.at, angle: p.angle + Math.PI, loaded: true }
      }
    }
  }
  return { parts, agv }
}

// 時刻の表示（h:mm:ss、1 時間未満は m:ss）
export function formatClock(seconds: number): string {
  const s = Math.floor(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}
