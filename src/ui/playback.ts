// 流れの再生: 左の欄の「流れの再生」で再生・一時停止・最初から・速さ。成形品の移動、ストッカーの溜まり具合、AGV を図面に重ねて描く。
// 計算は src/core/playback.ts の純関数。再生の状態は画面の状態で、シーンにも履歴にも入れない。
// シーンが変わったら（配置を変えた、案を切り替えた）、筋書きを作り直して最初から再生する。
import type { Canvas } from './canvas'
import type { Editor } from './editor'
import {
  DEFAULT_FLOW_PARAMS,
  flowView,
  formatClock,
  initialFlow,
  prepareFlow,
  stepFlow,
  type FlowModel,
  type FlowState,
} from '../core/playback'
import { footprint, type Scene } from '../core/scene'

const SVG_NS = 'http://www.w3.org/2000/svg'
// 再生の速さ（実際の時間の何倍か）
const SPEEDS = [1, 10, 60, 300]
const DEFAULT_SPEED = 60
// 画面が止まっていた（別のタブを見ていた）ときに、一度に進める実時間の上限（秒）
const MAX_FRAME = 0.1
// 成形品の点の半径と AGV・台車の大きさ（mm。架空の目安）
const PART_R = 150
const AGV_L = 1400
const AGV_W = 900

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v))
  return el
}

export function mountPlayback(canvas: Canvas, editor: Editor): void {
  // 工程のつなぎの矢印より上に描く
  const layer = svg('g', { class: 'playback-layer' })
  canvas.world.querySelector('.link-layer')!.after(layer)

  const params = DEFAULT_FLOW_PARAMS
  let scene: Scene = editor.scene()
  let model: FlowModel = prepareFlow(scene)
  let state: FlowState = initialFlow(model)
  let playing = false
  let speed = DEFAULT_SPEED
  let frame = 0
  let last = 0

  // ---- 左の欄 ----
  const h = document.createElement('h2')
  h.textContent = '流れの再生'
  const actions = document.createElement('div')
  actions.className = 'actions playback-actions'
  const playBtn = document.createElement('button')
  playBtn.type = 'button'
  playBtn.addEventListener('click', () => (playing ? pause() : play()))
  const resetBtn = document.createElement('button')
  resetBtn.type = 'button'
  resetBtn.textContent = '最初から'
  resetBtn.title = '時刻を 0 に戻す（ストッカーは空、AGV は出入り口）'
  resetBtn.addEventListener('click', () => restart())
  const speedSel = document.createElement('select')
  speedSel.title = '再生の速さ（実際の時間の何倍か）'
  for (const s of SPEEDS) {
    const o = document.createElement('option')
    o.value = String(s)
    o.textContent = `${s}×`
    speedSel.append(o)
  }
  speedSel.value = String(speed)
  speedSel.addEventListener('change', () => {
    speed = Number(speedSel.value)
    speedSel.blur()
  })
  actions.append(playBtn, resetBtn, speedSel)
  const info = document.createElement('div')
  info.className = 'info playback-info'
  const warn = document.createElement('div')
  warn.className = 'hint playback-warn'
  const note = document.createElement('div')
  note.className = 'hint'
  note.textContent =
    `サイクル ${params.cycleTime} 秒、ストッカー ${params.stockerCapacity} 個で満杯、AGV ${params.agvSpeed / 1000} m/秒・台車の入れ替え ${params.agvHandlingTime} 秒（架空の目安）。` +
    'AGV は最初に描いた通路の始点から出入りする'

  // 工程のつなぎの欄の下に置く
  const flowHint = canvas.side.querySelector('.link-actions')?.nextElementSibling
  if (flowHint) flowHint.after(h, actions, info, warn, note)
  else canvas.side.append(h, actions, info, warn, note)

  // ---- 再生 ----
  const tick = (now: number) => {
    const real = Math.min(MAX_FRAME, Math.max(0, (now - last) / 1000))
    last = now
    state = stepFlow(model, params, state, real * speed)
    paint()
    frame = requestAnimationFrame(tick)
  }
  const play = () => {
    if (playing) return
    playing = true
    last = performance.now()
    frame = requestAnimationFrame(tick)
    paint()
  }
  const pause = () => {
    playing = false
    cancelAnimationFrame(frame)
    paint()
  }
  const restart = () => {
    state = initialFlow(model)
    paint()
  }

  // シーンが変わったら筋書きを作り直し、最初からにする（再生中なら続けて流す）
  const sync = () => {
    const s = editor.scene()
    if (s === scene) return
    scene = s
    model = prepareFlow(scene)
    state = initialFlow(model)
    paint()
  }
  editor.onRender(sync)

  const name = (id: string) => scene.equipment.find((e) => e.id === id)?.name ?? id

  // 分岐で今入れているストッカー（行き先がどれもストッカーなら、カーソルの指す 1 台）
  const filling = (): Set<string> => {
    const out = new Set<string>()
    for (const [from, outs] of Object.entries(model.next)) {
      if (!outs.every((o) => model.isStocker[o])) {
        for (const o of outs) if (model.isStocker[o]) out.add(o)
        continue
      }
      const cur = outs[state.cursor[from] ?? 0]
      if (cur) out.add(cur)
    }
    return out
  }

  function paint() {
    playBtn.textContent = playing ? '一時停止' : '再生'
    playBtn.classList.toggle('active', playing)
    resetBtn.disabled = state.time === 0
    warn.textContent = model.warnings.join('。')
    const held = Object.values(state.held).reduce((a, b) => a + b, 0)
    const agv = state.agv
    const agvText =
      agv.phase === 'idle'
        ? state.requests.length
          ? '出入り口で止まっている（通路がつながらない）'
          : '出入り口で待機'
        : agv.phase === 'going'
          ? `${name(agv.stocker)}へ向かう`
          : agv.phase === 'loading'
            ? `${name(agv.stocker)}で台車を入れ替え`
            : `${name(agv.stocker)}の台車を運び出し中`
    const lines = [
      `経過 ${formatClock(state.time)}　成形 ${state.produced} 個　運び出し ${state.carts} 台車` + (held ? `　待ち ${held} 個` : ''),
      ...(model.home ? [`AGV: ${agvText}`] : []),
      ...model.stockers.map((id) => {
        const s = state.stockers[id]!
        const how = s.full ? (agv.phase !== 'idle' && agv.stocker === id ? '入れ替え待ち' : '満杯・AGV 待ち') : ''
        return `${name(id)}: ${s.count} / ${params.stockerCapacity}${how ? `（${how}）` : ''}`
      }),
    ]
    info.replaceChildren(
      ...lines.map((t) => {
        const d = document.createElement('div')
        d.textContent = t
        return d
      }),
    )

    // 図面: 止めて時刻 0 なら何も重ねない（配置の編集の邪魔をしない）
    if (!playing && state.time === 0) {
      layer.replaceChildren()
      return
    }
    const out: SVGElement[] = []
    const active = filling()
    // 出入り口と、ストッカーの乗り場
    if (model.home) {
      out.push(svg('circle', { class: 'agv-home', cx: model.home.x, cy: model.home.y, r: 400 }))
      for (const [id, d] of Object.entries(model.docks)) {
        const e = scene.equipment.find((q) => q.id === id)
        if (e) out.push(svg('line', { class: 'agv-dock', x1: d.x, y1: d.y, x2: e.x, y2: e.y }))
      }
    }
    // ストッカーの溜まり具合（下から積み上がる帯と、数）
    for (const id of model.stockers) {
      const e = scene.equipment.find((q) => q.id === id)
      const s = state.stockers[id]
      if (!e || !s) continue
      const f = footprint(e)
      const ratio = Math.min(1, s.count / params.stockerCapacity)
      const cls = `stocker-gauge${s.full ? ' full' : active.has(id) ? ' filling' : ''}`
      const g = svg('g', { class: cls })
      g.append(
        svg('rect', { class: 'gauge-frame', x: f.x, y: f.y, width: f.width, height: f.height }),
        svg('rect', { class: 'gauge-fill', x: f.x, y: f.y + f.height * (1 - ratio), width: f.width, height: f.height * ratio }),
      )
      const t = svg('text', { class: 'gauge-text', x: e.x, y: f.y - 150, 'font-size': 300 })
      t.textContent = `${s.count}/${params.stockerCapacity}${s.full ? ' 満杯' : ''}`
      g.append(t)
      out.push(g)
    }
    // 待っている成形品の数
    for (const [id, n] of Object.entries(state.held)) {
      const e = scene.equipment.find((q) => q.id === id)
      if (!e || !n) continue
      const f = footprint(e)
      const t = svg('text', { class: 'held-text', x: e.x, y: f.y - 150, 'font-size': 300 })
      t.textContent = `待ち ${n}`
      out.push(t)
    }
    const view = flowView(model, state)
    for (const p of view.parts) out.push(svg('circle', { class: 'flow-part', cx: p.x, cy: p.y, r: PART_R }))
    if (view.agv) {
      const deg = (view.agv.angle * 180) / Math.PI
      const g = svg('g', { class: `agv${view.agv.loaded ? ' loaded' : ''}`, transform: `translate(${view.agv.at.x} ${view.agv.at.y}) rotate(${deg})` })
      g.append(svg('rect', { class: 'agv-body', x: -AGV_L / 2, y: -AGV_W / 2, width: AGV_L, height: AGV_W, rx: 150 }))
      // 進む向きの印
      g.append(svg('polygon', { class: 'agv-nose', points: `${AGV_L / 2 - 50},0 ${AGV_L / 2 - 350},${-AGV_W / 2 + 150} ${AGV_L / 2 - 350},${AGV_W / 2 - 150}` }))
      if (view.agv.loaded) g.append(svg('rect', { class: 'agv-cart', x: -AGV_L / 2 + 150, y: -AGV_W / 2 + 120, width: AGV_L - 550, height: AGV_W - 240 }))
      out.push(g)
    }
    layer.replaceChildren(...out)
  }

  // Space は画面の移動に使うので、再生・一時停止は P
  const isInteractive = (t: EventTarget | null) =>
    t instanceof HTMLElement && (t.isContentEditable || t.closest('input, select, textarea') !== null)
  window.addEventListener('keydown', (e) => {
    if (isInteractive(e.target) || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return
    if (e.key !== 'p' && e.key !== 'P') return
    e.preventDefault()
    if (playing) pause()
    else play()
  })

  paint()
}
