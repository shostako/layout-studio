// 流れの再生: 左の欄の「流れの再生」で再生・一時停止・最初から・速さ。成形品の移動、ストッカーの溜まり具合、AGV を図面に重ねて描く。
// 計算は src/core/playback.ts の純関数。再生の状態は画面の状態で、シーンにも履歴にも入れない。
// サイクル・容量・AGV の速さ・入れ替えの時間・AGV の台数はシーンの flow で、欄で変えると setFlow のコマンドを出す（元に戻せる、案ごとに保存）。
// シーンが変わったら（配置や数値を変えた、案を切り替えた）、筋書きを作り直して最初から再生する。
import type { Canvas } from './canvas'
import type { Editor } from './editor'
import {
  flowParams,
  flowView,
  formatClock,
  initialFlow,
  agvUtilization,
  prepareFlow,
  stepFlow,
  type FlowModel,
  type FlowParams,
  type AgvState,
  type FlowState,
} from '../core/playback'
import { FLOW_LIMITS, footprint, type FlowSettings, type Scene } from '../core/scene'

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

  let scene: Scene = editor.scene()
  let params: FlowParams = flowParams(scene.flow)
  let model: FlowModel = prepareFlow(scene)
  let state: FlowState = initialFlow(model, params)
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
  // 数値の欄。画面では AGV の速さを m/秒で見せる（シーンは mm/秒）。確定（Enter か欄を離れたとき）で setFlow を 1 回出す
  const FIELDS: { key: keyof FlowSettings; label: string; scale: number; step: number; title: string }[] = [
    { key: 'cycleTime', label: 'サイクル 秒', scale: 1, step: 1, title: '成形のサイクル時間（秒）。成形機 1 台がこの時間ごとに 1 個つくる' },
    { key: 'stockerCapacity', label: '容量 個', scale: 1, step: 1, title: 'ストッカー 1 台に入る数。この数で満杯になり AGV を呼ぶ' },
    { key: 'agvSpeed', label: 'AGV m/秒', scale: 1000, step: 0.1, title: 'AGV が通路を走る速さ（m/秒）' },
    { key: 'agvHandlingTime', label: '入れ替え 秒', scale: 1, step: 5, title: 'AGV がストッカーで満杯の台車を空の台車と替える時間（秒）' },
    { key: 'agvCount', label: 'AGV 台', scale: 1, step: 1, title: 'AGV の台数。空いている AGV が呼ばれた順にストッカーへ行く（AGV どうしはぶつからない扱い）' },
  ]
  const props = document.createElement('div')
  props.className = 'props playback-params'
  const inputs = new Map<keyof FlowSettings, HTMLInputElement>()
  for (const f of FIELDS) {
    const lim = FLOW_LIMITS[f.key]
    const i = document.createElement('input')
    i.type = 'number'
    i.min = String(lim.min / f.scale)
    i.max = String(lim.max / f.scale)
    i.step = String(f.step)
    i.title = `${f.title}。${lim.min / f.scale}〜${lim.max / f.scale}`
    i.addEventListener('change', () => {
      const v = Number(i.value)
      // 空や範囲外はコマンドが断る。断られたら元の値に戻す
      if (i.value === '' || !editor.run({ type: 'setFlow', changes: { [f.key]: Math.round(v * f.scale * 1e6) / 1e6 } }))
        i.value = String(scene.flow[f.key] / f.scale)
    })
    i.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') i.blur()
    })
    const l = document.createElement('label')
    l.title = i.title
    l.append(f.label, i)
    props.append(l)
    inputs.set(f.key, i)
  }
  const showParams = () => {
    for (const f of FIELDS) {
      const i = inputs.get(f.key)!
      if (document.activeElement !== i) i.value = String(scene.flow[f.key] / f.scale)
    }
  }
  const note = document.createElement('div')
  note.className = 'hint'
  note.textContent = '数値は案ごとに保存し、元に戻せる。変えると最初から再生する。AGV は最初に描いた通路の始点から出入りする'

  // 工程のつなぎの欄の下に置く
  const flowHint = canvas.side.querySelector('.link-actions')?.nextElementSibling
  if (flowHint) flowHint.after(h, actions, props, info, warn, note)
  else canvas.side.append(h, actions, props, info, warn, note)

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
    state = initialFlow(model, params)
    paint()
  }

  // シーンが変わったら筋書きを作り直し、最初からにする（再生中なら続けて流す）
  const sync = () => {
    const s = editor.scene()
    if (s === scene) return
    scene = s
    params = flowParams(scene.flow)
    model = prepareFlow(scene)
    state = initialFlow(model, params)
    showParams()
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
    const agvText = (agv: AgvState) =>
      agv.phase === 'idle'
        ? state.requests.length
          ? '出入り口で止まっている（通路がつながらない）'
          : '出入り口で待機'
        : agv.phase === 'going'
          ? `${name(agv.stocker)}へ向かう`
          : agv.phase === 'loading'
            ? `${name(agv.stocker)}で台車を入れ替え`
            : `${name(agv.stocker)}の台車を運び出し中`
    const use = agvUtilization(state)
    const many = state.agvs.length > 1
    const lines = [
      `経過 ${formatClock(state.time)}　成形 ${state.produced} 個　運び出し ${state.carts} 台車` + (held ? `　待ち ${held} 個` : ''),
      ...(model.home
        ? state.agvs.map(
            (a, i) => `AGV${many ? ` ${i + 1}` : ''}: ${agvText(a)}` + (state.time > 0 ? `（稼働 ${Math.round(use[i]! * 100)}%）` : ''),
          )
        : []),
      ...model.stockers.map((id) => {
        const s = state.stockers[id]!
        const coming = state.agvs.some((a) => a.phase !== 'idle' && a.stocker === id)
        const how = s.full ? (coming ? '入れ替え待ち' : '満杯・AGV 待ち') : ''
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
    for (const agv of view.agvs) {
      const deg = (agv.angle * 180) / Math.PI
      const g = svg('g', { class: `agv${agv.loaded ? ' loaded' : ''}`, transform: `translate(${agv.at.x} ${agv.at.y}) rotate(${deg})` })
      g.append(svg('rect', { class: 'agv-body', x: -AGV_L / 2, y: -AGV_W / 2, width: AGV_L, height: AGV_W, rx: 150 }))
      // 進む向きの印
      g.append(svg('polygon', { class: 'agv-nose', points: `${AGV_L / 2 - 50},0 ${AGV_L / 2 - 350},${-AGV_W / 2 + 150} ${AGV_L / 2 - 350},${AGV_W / 2 - 150}` }))
      if (agv.loaded) g.append(svg('rect', { class: 'agv-cart', x: -AGV_L / 2 + 150, y: -AGV_W / 2 + 120, width: AGV_L - 550, height: AGV_W - 240 }))
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

  showParams()
  paint()
}
