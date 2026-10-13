// 設備の配置の操作: ひな形から置く、選ぶ、ドラッグで動かす、スナップ、回転、削除、元に戻す・やり直す。
// シーンは必ずコマンド（src/core/commands.ts）を history.execute に通して変える。
// 選択・置く途中・ドラッグ中の見た目は画面の状態で、シーンには入れない。
import type { Canvas } from './canvas'
import { applyCommand, type Command } from '../core/commands'
import { canRedo, canUndo, createHistory, execute, redo, undo, type History } from '../core/history'
import { DEFAULT_SNAP, SNAP_STEPS, hitTest, snapCenter, snapMove } from '../core/placement'
import { createEmptyScene, footprint, nextEquipmentId, type Equipment, type Rotation, type Scene } from '../core/scene'
import { TEMPLATES, equipmentFromTemplate, nextEquipmentName, type EquipmentTemplate } from '../core/templates'
import { formatLength, type Point } from '../core/viewport'

const SVG_NS = 'http://www.w3.org/2000/svg'
// この px より動かしたらドラッグとみなす（クリックで設備がずれないように）
const DRAG_THRESHOLD_PX = 3
// スナップしないときの矢印キー 1 回の移動量
const NUDGE_NO_SNAP = 10

// 背景の縮尺合わせなど、左クリックで図面の点を拾う道具。editor が左クリックと Esc を渡す
export type Tool = {
  pointerDown(at: Point, e: PointerEvent): void
  // world の層に重ねて描くもの（カーソルの位置を受け取る）
  overlay(pointer: Point | null): SVGElement[]
  // 道具が使われなくなったとき（Esc、別の操作を始めた、endTool）に呼ぶ
  ended(): void
}

// 他の画面の部品（背景の欄など）が、同じ履歴にコマンドを通すための口
export type Editor = {
  run(cmd: Command): boolean
  scene(): Scene
  startTool(tool: Tool): void
  endTool(tool: Tool): void
  render(): void
  // シーンや表示が変わって描き直すたびに呼ぶ
  onRender(listener: () => void): void
  // 履歴を捨てて、このシーンから始め直す（起動時に自動保存から戻すときだけ使う。ふだんの操作は run を通す）
  reset(scene: Scene): void
}

type Mode =
  | { type: 'idle' }
  | { type: 'tool'; tool: Tool }
  | { type: 'placing'; template: EquipmentTemplate; width: number; depth: number; rotation: Rotation }
  | {
      type: 'dragging'
      pointerId: number
      startClient: Point
      startWorld: Point
      grabId: string
      ids: string[]
      dx: number
      dy: number
      moved: boolean
    }

const turn = (r: Rotation, q: number): Rotation => ((((r / 90 + q) % 4) + 4) % 4) * 90 as Rotation

export function mountEditor(canvas: Canvas): Editor {
  let history: History = createHistory(createEmptyScene())
  let selected: string[] = []
  let mode: Mode = { type: 'idle' }
  let snap = DEFAULT_SNAP
  let pointer: Point | null = null // 図面の座標でのカーソル
  let message = ''
  // ひな形ごとに、次に置くときの寸法（使う人が変えられる）
  const sizes = new Map(TEMPLATES.map((t) => [t.kind, { width: t.width, depth: t.depth }]))

  const layer = document.createElementNS(SVG_NS, 'g')
  layer.setAttribute('class', 'equipment-layer')
  const toolLayer = document.createElementNS(SVG_NS, 'g')
  toolLayer.setAttribute('class', 'tool-layer')
  canvas.world.append(layer, toolLayer)
  const listeners: (() => void)[] = []

  // 今の操作をやめて別の操作に移る。道具を使っていたら知らせる
  const setMode = (next: Mode) => {
    const prev = mode
    mode = next
    if (prev.type === 'tool' && !(next.type === 'tool' && next.tool === prev.tool)) prev.tool.ended()
  }

  // ---- コマンドを通す ----
  const run = (cmd: Command): boolean => {
    const r = execute(history, cmd)
    history = r.history
    message = r.ok ? '' : r.error
    render()
    return r.ok
  }
  const scene = (): Scene => history.present
  const liveSelection = () => selected.filter((id) => scene().equipment.some((e) => e.id === id))

  const rotateSelection = (q: number) => {
    const ids = liveSelection()
    if (ids.length) run({ type: 'rotate', ids, quarterTurns: q })
  }
  const removeSelection = () => {
    const ids = liveSelection()
    if (ids.length && run({ type: 'remove', ids })) selected = []
    render()
  }
  const nudge = (kx: number, ky: number) => {
    const ids = liveSelection()
    const step = snap > 0 ? snap : NUDGE_NO_SNAP
    if (ids.length) run({ type: 'move', ids, dx: kx * step, dy: ky * step })
  }
  const doUndo = () => {
    history = undo(history)
    message = ''
    render()
  }
  const doRedo = () => {
    history = redo(history)
    message = ''
    render()
  }
  const startPlacing = (t: EquipmentTemplate) => {
    const size = sizes.get(t.kind)!
    setMode({ type: 'placing', template: t, width: size.width, depth: size.depth, rotation: 0 })
    selected = []
    render()
  }
  const cancel = () => {
    setMode({ type: 'idle' })
    render()
  }

  // ---- 左の欄: ひな形と選択中の設備 ----
  const side = canvas.side
  const h1 = document.createElement('h2')
  h1.textContent = 'ひな形'
  const list = document.createElement('div')
  list.className = 'templates'
  const templateButtons = new Map<string, HTMLButtonElement>()
  for (const t of TEMPLATES) {
    const row = document.createElement('div')
    row.className = 'template'
    const b = document.createElement('button')
    b.type = 'button'
    b.title = `${t.name}を置く（クリックで位置を決める。R で回す、Esc でやめる）`
    const sw = document.createElement('span')
    sw.className = 'swatch'
    sw.style.background = t.color
    b.append(sw, document.createTextNode(t.name))
    b.addEventListener('click', () => startPlacing(t))
    templateButtons.set(t.kind, b)
    const size = sizes.get(t.kind)!
    const mkInput = (key: 'width' | 'depth', label: string) => {
      const input = document.createElement('input')
      input.type = 'number'
      input.min = '1'
      input.step = '10'
      input.value = String(size[key])
      input.title = `${t.name}の${label}（mm）。これから置くものに使う`
      input.addEventListener('change', () => {
        const v = Number(input.value)
        if (v > 0 && Number.isFinite(v)) size[key] = v
        else input.value = String(size[key])
        if (mode.type === 'placing' && mode.template.kind === t.kind) mode = { ...mode, [key]: size[key] }
        render()
      })
      return input
    }
    const dims = document.createElement('span')
    dims.className = 'dims'
    dims.append(mkInput('width', '幅'), '×', mkInput('depth', '奥行'))
    row.append(b, dims)
    list.append(row)
  }
  const h2 = document.createElement('h2')
  h2.textContent = '選択中'
  const info = document.createElement('div')
  info.className = 'info'
  const actions = document.createElement('div')
  actions.className = 'actions'
  const mkAction = (label: string, title: string, onClick: () => void) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = label
    b.title = title
    b.addEventListener('click', onClick)
    actions.append(b)
    return b
  }
  const rotLeft = mkAction('⟲ 90°', '反時計回りに 90 度（Shift+R）', () => rotateSelection(-1))
  const rotRight = mkAction('⟳ 90°', '時計回りに 90 度（R）', () => rotateSelection(1))
  const del = mkAction('削除', '選択中の設備を消す（Delete）', removeSelection)
  const msg = document.createElement('div')
  msg.className = 'message'
  const keys = document.createElement('div')
  keys.className = 'keys'
  keys.textContent =
    'クリック: 選ぶ　Shift+クリック: 足す・外す　ドラッグ: 動かす　R / Shift+R: 回す　矢印: スナップ幅ずつ動かす　Delete: 消す　Ctrl+Z / Ctrl+Y: 元に戻す / やり直す　Esc: やめる'
  side.append(h1, list, h2, info, actions, msg, keys)

  // ---- 上の道具バー: 元に戻す・やり直す・スナップ ----
  const group = document.createElement('span')
  group.className = 'group'
  const mkTool = (label: string, title: string, onClick: () => void) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = label
    b.title = title
    b.addEventListener('click', onClick)
    group.append(b)
    return b
  }
  const undoBtn = mkTool('元に戻す', '元に戻す（Ctrl+Z）', doUndo)
  const redoBtn = mkTool('やり直す', 'やり直す（Ctrl+Y / Ctrl+Shift+Z）', doRedo)
  const snapLabel = document.createElement('label')
  snapLabel.textContent = 'スナップ '
  const snapSelect = document.createElement('select')
  for (const s of SNAP_STEPS) {
    const o = document.createElement('option')
    o.value = String(s)
    o.textContent = s === 0 ? 'なし' : formatLength(s)
    snapSelect.append(o)
  }
  snapSelect.value = String(snap)
  snapSelect.title = '設備の外形の左上をこの間隔のグリッドに合わせる'
  snapSelect.addEventListener('change', () => {
    snap = Number(snapSelect.value)
    snapSelect.blur()
    render()
  })
  snapLabel.append(snapSelect)
  group.append(snapLabel)
  canvas.toolbar.insertBefore(group, canvas.toolbar.querySelector('.help'))

  // ---- 描く ----
  const rectAttrs = (eq: Equipment) => {
    const fp = footprint(eq)
    return { x: fp.x, y: fp.y, width: fp.width, height: fp.height }
  }
  const drawEquipment = (eq: Equipment, cls: string): SVGGElement => {
    const g = document.createElementNS(SVG_NS, 'g')
    g.setAttribute('class', cls)
    const r = document.createElementNS(SVG_NS, 'rect')
    for (const [k, v] of Object.entries(rectAttrs(eq))) r.setAttribute(k, String(v))
    r.setAttribute('fill', eq.color)
    r.setAttribute('stroke', eq.color)
    // 向きが分かるよう、回転 0 のときの上辺（奥）に印を付ける
    const fp = footprint(eq)
    const mark = document.createElementNS(SVG_NS, 'path')
    const m = Math.min(fp.width, fp.height) * 0.12
    const edge: Record<Rotation, string> = {
      0: `M${fp.x} ${fp.y + m}H${fp.x + fp.width}`,
      90: `M${fp.x + fp.width - m} ${fp.y}V${fp.y + fp.height}`,
      180: `M${fp.x} ${fp.y + fp.height - m}H${fp.x + fp.width}`,
      270: `M${fp.x + m} ${fp.y}V${fp.y + fp.height}`,
    }
    mark.setAttribute('d', edge[eq.rotation])
    mark.setAttribute('class', 'front')
    const label = document.createElementNS(SVG_NS, 'text')
    label.setAttribute('x', String(eq.x))
    label.setAttribute('y', String(eq.y))
    const fontSize = Math.min(300, Math.min(fp.width, fp.height) * 0.28, fp.width / Math.max(eq.name.length, 1) / 1.1)
    label.setAttribute('font-size', String(fontSize))
    label.textContent = eq.name
    g.append(r, mark, label)
    return g
  }

  function render() {
    // ドラッグ中は、移動のコマンドを仮に当てた結果を見せる（履歴には積まない）
    let shown = scene()
    if (mode.type === 'dragging' && mode.moved) {
      const r = applyCommand(shown, { type: 'move', ids: mode.ids, dx: mode.dx, dy: mode.dy })
      if (r.ok) shown = r.scene
    }
    selected = liveSelection()
    const sel = new Set(selected)
    layer.replaceChildren(
      ...shown.equipment.map((eq) => drawEquipment(eq, sel.has(eq.id) ? 'equipment selected' : 'equipment')),
    )
    if (mode.type === 'placing' && pointer) layer.append(drawEquipment(ghost(mode, pointer), 'equipment ghost'))
    toolLayer.replaceChildren(...(mode.type === 'tool' ? mode.tool.overlay(pointer) : []))
    canvas.svg.classList.toggle('picking', mode.type === 'tool')

    canvas.svg.classList.toggle('placing', mode.type === 'placing')
    for (const [kind, b] of templateButtons)
      b.classList.toggle('active', mode.type === 'placing' && mode.template.kind === kind)

    const items = shown.equipment.filter((e) => sel.has(e.id))
    if (mode.type === 'placing') {
      info.textContent = `${mode.template.name}を置く: ${mode.width} × ${mode.depth} mm、${mode.rotation}°。クリックで置く`
    } else if (items.length === 1) {
      const e = items[0]!
      const fp = footprint(e)
      info.textContent = `${e.name}　${e.width} × ${e.depth} mm、${e.rotation}°　中心 (${Math.round(e.x)}, ${Math.round(e.y)})　左上 (${Math.round(fp.x)}, ${Math.round(fp.y)})`
    } else if (items.length > 1) {
      info.textContent = `${items.length} 台`
    } else {
      info.textContent = 'なし'
    }
    for (const b of [rotLeft, rotRight, del]) b.disabled = items.length === 0
    undoBtn.disabled = !canUndo(history)
    redoBtn.disabled = !canRedo(history)
    msg.textContent = message
    for (const f of listeners) f()
  }

  const ghost = (m: Extract<Mode, { type: 'placing' }>, at: Point): Equipment =>
    equipmentFromTemplate(m.template, {
      id: '',
      name: m.template.name,
      center: snapCenter(m, at, snap),
      width: m.width,
      depth: m.depth,
      rotation: m.rotation,
    })

  // ---- マウス ----
  const svgEl = canvas.svg
  svgEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || canvas.isPanKeyDown()) return
    const at = canvas.toWorld(e.clientX, e.clientY)
    pointer = at
    if (mode.type === 'tool') {
      mode.tool.pointerDown(at, e)
      render()
      return
    }
    if (mode.type === 'placing') {
      const m = mode
      const eq = { ...ghost(m, at), id: nextEquipmentId(scene()), name: nextEquipmentName(scene(), m.template) }
      mode = { type: 'idle' }
      if (run({ type: 'add', equipment: eq })) selected = [eq.id]
      render()
      return
    }
    const hit = hitTest(scene(), at)
    if (!hit) {
      if (!e.shiftKey) selected = []
      render()
      return
    }
    if (e.shiftKey) {
      selected = selected.includes(hit) ? selected.filter((id) => id !== hit) : [...selected, hit]
      render()
      if (!selected.includes(hit)) return
    } else if (!selected.includes(hit)) {
      selected = [hit]
    }
    mode = {
      type: 'dragging',
      pointerId: e.pointerId,
      startClient: { x: e.clientX, y: e.clientY },
      startWorld: at,
      grabId: hit,
      ids: [...selected],
      dx: 0,
      dy: 0,
      moved: false,
    }
    svgEl.setPointerCapture(e.pointerId)
    render()
  })

  svgEl.addEventListener('pointermove', (e) => {
    const at = canvas.toWorld(e.clientX, e.clientY)
    pointer = at
    if (mode.type === 'dragging' && e.pointerId === mode.pointerId) {
      const far = Math.hypot(e.clientX - mode.startClient.x, e.clientY - mode.startClient.y) > DRAG_THRESHOLD_PX
      if (!mode.moved && !far) return
      const grabId = mode.grabId
      const grab = scene().equipment.find((x) => x.id === grabId)
      if (!grab) return
      // つかんだ設備を基準にスナップし、選んだ設備をすべて同じだけ動かす
      const d = snapMove(grab, at.x - mode.startWorld.x, at.y - mode.startWorld.y, snap)
      mode = { ...mode, dx: d.dx, dy: d.dy, moved: true }
      svgEl.classList.add('dragging')
      render()
    } else if (mode.type === 'placing' || mode.type === 'tool') {
      render()
    }
  })

  const endDrag = (e: PointerEvent, commit: boolean) => {
    if (mode.type !== 'dragging' || e.pointerId !== mode.pointerId) return
    const m = mode
    mode = { type: 'idle' }
    svgEl.classList.remove('dragging')
    if (commit && m.moved && (m.dx !== 0 || m.dy !== 0)) run({ type: 'move', ids: m.ids, dx: m.dx, dy: m.dy })
    else render()
  }
  svgEl.addEventListener('pointerup', (e) => endDrag(e, true))
  svgEl.addEventListener('pointercancel', (e) => endDrag(e, false))
  svgEl.addEventListener('pointerleave', () => {
    if (mode.type === 'placing' || mode.type === 'tool') {
      pointer = null
      render()
    }
  })

  // ---- キー ----
  const isInteractive = (t: EventTarget | null) =>
    t instanceof HTMLElement && (t.isContentEditable || t.closest('input, select, textarea') !== null)
  window.addEventListener('keydown', (e) => {
    if (isInteractive(e.target) || mode.type === 'dragging') return
    const mod = e.ctrlKey || e.metaKey
    if (mod && !e.altKey) {
      const k = e.key.toLowerCase()
      if (k === 'z' && !e.shiftKey) doUndo()
      else if (k === 'y' || (k === 'z' && e.shiftKey)) doRedo()
      else return
      e.preventDefault()
      return
    }
    if (e.altKey || mod) return
    if (mode.type === 'tool') {
      if (e.key !== 'Escape') return
      cancel()
      e.preventDefault()
      return
    }
    if (e.key === 'r' || e.key === 'R') {
      const q = e.shiftKey ? -1 : 1
      if (mode.type === 'placing') {
        mode = { ...mode, rotation: turn(mode.rotation, q) }
        render()
      } else rotateSelection(q)
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      removeSelection()
    } else if (e.key === 'Escape') {
      if (mode.type === 'placing') cancel()
      else {
        selected = []
        render()
      }
    } else if (e.key.startsWith('Arrow')) {
      const d: Record<string, [number, number]> = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
      }
      const v = d[e.key]
      if (!v || liveSelection().length === 0) return
      nudge(v[0], v[1])
    } else return
    e.preventDefault()
  })

  render()
  return {
    run,
    scene,
    startTool: (tool) => {
      setMode({ type: 'tool', tool })
      selected = []
      message = ''
      render()
    },
    endTool: (tool) => {
      if (mode.type === 'tool' && mode.tool === tool) cancel()
    },
    render,
    onRender: (f) => listeners.push(f),
    reset: (next) => {
      setMode({ type: 'idle' })
      history = createHistory(next)
      selected = []
      message = ''
      render()
    },
  }
}
