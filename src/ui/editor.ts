// 設備の配置の操作: ひな形から置く、選ぶ、ドラッグで動かす、スナップ、回転、複製、削除、名前・寸法・色・余白の変更、元に戻す・やり直す。
// 設備どうし・設備と通路の重なりと、保守用の余白への入り込みを示す（置く途中とドラッグ中は、置く先・動かした先で判定する）。
// シーンは必ずコマンド（src/core/commands.ts）を history.execute に通して変える。
// 選択・置く途中・ドラッグ中の見た目は画面の状態で、シーンには入れない。
import type { Canvas } from './canvas'
import { applyCommand, type Command, type EquipmentChanges } from '../core/commands'
import { canRedo, canUndo, createHistory, execute, redo, undo, type History } from '../core/history'
import { DEFAULT_SNAP, SNAP_STEPS, hitTest, snapCenter, snapMove } from '../core/placement'
import { clearanceEquipment, findOverlaps, overlappingEquipment, type Overlap } from '../core/overlap'
import { equipmentOutsideSite } from '../core/site'
import { clearanceRect, createEmptyScene, equipmentBounds, footprint, nextEquipmentId, nextEquipmentIds, worldClearance, type Clearance, type Equipment, type Rotation, type Scene } from '../core/scene'
import { equipmentFromTemplate, findTemplate, nextEquipmentName, type EquipmentTemplate } from '../core/templates'
import { rotateWithUnits, unitsOf, withUnits } from '../core/unit'
import { formatLength, type Point } from '../core/viewport'

const SVG_NS = 'http://www.w3.org/2000/svg'
// この px より動かしたらドラッグとみなす（クリックで設備がずれないように）
const DRAG_THRESHOLD_PX = 3
// 指は触れたときに少し揺れるので、これより動いたらドラッグとみなす
const TOUCH_SLOP_PX = 10
// スナップしないときの矢印キー 1 回の移動量
const NUDGE_NO_SNAP = 10
// 「ユニットごと」の入り切りを覚えるキー（見る人の好み。シーンには入れない）
const UNIT_MODE_KEY = 'layout-studio:unit-mode'

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
  // 履歴をまるごと読む・差し替える（案の切り替えで、案ごとの元に戻すを持ち回る）。差し替えると選択と操作の途中は捨てる
  history(): History
  restore(history: History): void
  // reset・restore で履歴を差し替えたときに呼ぶ（通路の選択を外すなど）
  onReset(listener: () => void): void
  // 今のスナップの間隔（mm、0 はスナップしない）。敷地の頂点を拾うときにも使う
  snapStep(): number
  // 選択中の設備の id
  selection(): string[]
  // 設備の選択を変える
  select(ids: string[]): void
  // 通路やつなぎなど、設備でないものを選ぶ部品が呼ぶ。設備の選択を外し、他の部品に owner を知らせる（受けた部品は自分の選択を外す）。
  // 設備・通路・つなぎは同時に選ばない
  claimSelection(owner: string): void
  onClaim(listener: (owner: string) => void): void
  // ふだんの操作で、設備の無い所を左クリックしたときに呼ぶ（通路を選ぶのに使う）。
  // 設備の選択は呼ぶ前に外している（Shift なしのとき）
  onEmptyClick(listener: (at: Point, e: PointerEvent) => void): void
  // ふだんの操作で左ボタンを押したとき、設備の当たり判定より先に呼ぶ。Grab を返すと、そのドラッグを引き受ける（通路の頂点や通路ごとの移動）
  onGrab(listener: (at: Point, e: PointerEvent) => Grab | null): void
  // 今描いているシーン（ドラッグ中は、仮に当てたコマンドの結果）
  shown(): Scene
  // 複数選ぶ（Shift を押したままと同じ。指で触る画面のため）
  multiSelect(): boolean
  setMultiSelect(on: boolean): void
}

// 他の部品が引き受けるドラッグ。動かすたびに仮のコマンドを返し、editor がそれを当てた結果を描く。離したときに 1 回だけ実行する。
// 動かさずに離したら click を呼ぶ
export type Grab = {
  move(at: Point, e: PointerEvent): Command | null
  click?(): void
  // 離した後に呼ぶ。ok はコマンドが通ったか
  end?(ok: boolean): void
  // 指で触ったときは、動かすと画面の移動にし、動かさずに離したら click を呼ぶ（まだ選んでいないものを指で動かさないため）
  panOnTouch?: boolean
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
  | { type: 'grab'; pointerId: number; startClient: Point; grab: Grab; cmd: Command | null; moved: boolean }

const turn = (r: Rotation, q: number): Rotation => ((((r / 90 + q) % 4) + 4) % 4) * 90 as Rotation

export function mountEditor(canvas: Canvas): Editor {
  let history: History = createHistory(createEmptyScene())
  let selected: string[] = []
  let mode: Mode = { type: 'idle' }
  let snap = DEFAULT_SNAP
  let pointer: Point | null = null // 図面の座標でのカーソル
  let message = ''

  const layer = document.createElementNS(SVG_NS, 'g')
  layer.setAttribute('class', 'equipment-layer')
  // 保守用の余白。設備（と通路）より下に、薄い塗りと破線の枠で描く
  const clearanceLayer = document.createElementNS(SVG_NS, 'g')
  clearanceLayer.setAttribute('class', 'clearance-layer')
  // 余白に入っている部分。本体の重なり（赤）と分けて橙で描く
  const clearanceHitLayer = document.createElementNS(SVG_NS, 'g')
  clearanceHitLayer.setAttribute('class', 'clearance-hit-layer')
  const toolLayer = document.createElementNS(SVG_NS, 'g')
  toolLayer.setAttribute('class', 'tool-layer')
  // 重なっている部分。設備より上に、半透明の赤でまとめて描く（重なりどうしが濃くならないよう、透明度は層にかける）
  const overlapLayer = document.createElementNS(SVG_NS, 'g')
  overlapLayer.setAttribute('class', 'overlap-layer')
  canvas.world.append(clearanceLayer, layer, clearanceHitLayer, overlapLayer, toolLayer)
  const listeners: (() => void)[] = []
  const emptyClickListeners: ((at: Point, e: PointerEvent) => void)[] = []
  const grabListeners: ((at: Point, e: PointerEvent) => Grab | null)[] = []
  const claimListeners: ((owner: string) => void)[] = []
  let lastShown: Scene | null = null
  let multi = false
  // 指の 1 本での操作。動かすと画面の移動（canvas が受ける）、動かさずに離すと tap を呼ぶ
  let touchTap: { pointerId: number; startClient: Point; moved: boolean; tap: () => void } | null = null

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

  // ユニットごと: 基準の設備（成形機など）を動かす・回す・写すと、そのユニットの付帯設備も一緒に（見る人の好みで、ブラウザに覚える）
  let unitMode = true
  try {
    unitMode = localStorage.getItem(UNIT_MODE_KEY) !== 'off'
  } catch {
    // 覚えておけないブラウザでは、開いている間だけ効く
  }
  const expand = (ids: string[]) => (unitMode ? withUnits(scene(), ids) : ids)
  const rotateSelection = (q: number) => {
    const ids = liveSelection()
    if (!ids.length) return
    const cmd = unitMode ? rotateWithUnits(scene(), ids, q) : { type: 'rotate' as const, ids, quarterTurns: q }
    if (cmd) run(cmd)
  }
  const removeSelection = () => {
    const ids = liveSelection()
    if (ids.length && run({ type: 'remove', ids })) selected = []
    render()
  }
  // 選んだ設備を写し、まとめて囲む長方形の幅に余白の分を足して右に置く。写しを選び直すので、続けて押すと横に並ぶ。
  // 余白の分は、選んだ設備の左右の余白のうち最も広いもの（写しの本体が元の余白に入らず、余白どうしは重ねて共用する）
  // ユニットごとなら、選んだ基準の設備のユニットも写す（写しは選んでいた設備の写しだけを選び直す）
  const duplicateSelection = () => {
    const picked = liveSelection()
    const ids = expand(picked)
    const items = scene().equipment.filter((e) => ids.includes(e.id))
    const box = equipmentBounds(items)
    if (!box) return
    const gap = Math.max(0, ...items.map((e) => Math.max(worldClearance(e).left, worldClearance(e).right)))
    const order = items.map((e) => e.id)
    const newIds = nextEquipmentIds(scene(), order.length)
    if (run({ type: 'duplicate', ids: order, newIds, dx: box.width + gap, dy: 0 }))
      selected = order.flatMap((id, i) => (picked.includes(id) ? [newIds[i]!] : []))
    render()
  }
  // 欄に入った時点の選択を覚えておく。入力中にキャンバスで別の設備を選ぶと、
  // 確定（blur で change が来る）が選び直した後になるため
  let editIds: string[] = []
  const updateSelection = (changes: EquipmentChanges) => {
    const ids = (editIds.length ? editIds : liveSelection()).filter((id) => scene().equipment.some((e) => e.id === id))
    if (ids.length) run({ type: 'update', ids, changes })
  }
  const nudge = (kx: number, ky: number) => {
    const ids = expand(liveSelection())
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
    setMode({ type: 'placing', template: t, width: t.width, depth: t.depth, rotation: 0 })
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
  // ひな形の一覧はシーンが持つ（案ごと、元に戻せる）。一覧が変わったら作り直す
  let builtFor: readonly EquipmentTemplate[] | null = null
  const buildTemplateList = (templates: readonly EquipmentTemplate[]) => {
    builtFor = templates
    templateButtons.clear()
    list.replaceChildren()
    if (templates.length === 0) {
      const p = document.createElement('p')
      p.className = 'hint'
      p.textContent = '設備の種類がありません。下の「設備の種類を編集」で足してください。'
      list.append(p)
    }
    for (const t of templates) {
      const row = document.createElement('div')
      row.className = 'template'
      const b = document.createElement('button')
      b.type = 'button'
      b.title = `${t.name}を置く（クリックで位置を決める。R で回す、Esc でやめる）`
      const sw = document.createElement('span')
      sw.className = 'swatch'
      sw.style.background = t.color
      b.append(sw, document.createTextNode(t.name))
      b.addEventListener('click', () => startPlacing(findTemplate(scene().templates, t.kind) ?? t))
      templateButtons.set(t.kind, b)
      // 寸法はひな形そのものを変える（これから置くものに使う。置いた設備は変えない）
      const mkInput = (key: 'width' | 'depth', label: string) => {
        const input = document.createElement('input')
        input.type = 'number'
        input.min = '1'
        input.step = '10'
        input.value = String(t[key])
        input.title = `${t.name}の${label}（mm）。これから置くものに使う（置いた設備は変えない）`
        input.addEventListener('change', () => {
          const v = Number(input.value)
          const cur = scene().templates
          if (!(v > 0 && Number.isFinite(v)) || !run({ type: 'setTemplates', templates: cur.map((x) => (x.kind === t.kind ? { ...x, [key]: v } : x)) }))
            input.value = String(t[key])
        })
        return input
      }
      const dims = document.createElement('span')
      dims.className = 'dims'
      dims.append(mkInput('width', '幅'), '×', mkInput('depth', '奥行'))
      row.append(b, dims)
      list.append(row)
    }
  }
  // 置いている途中の種類を、今の一覧に合わせる（消えたらやめる、寸法が変わったら合わせる）
  const syncPlacing = () => {
    if (mode.type !== 'placing') return
    const t = findTemplate(scene().templates, mode.template.kind)
    if (!t) mode = { type: 'idle' }
    else if (t !== mode.template) mode = { ...mode, template: t, width: t.width, depth: t.depth }
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
  const unitLabel = document.createElement('label')
  unitLabel.className = 'unit-mode'
  unitLabel.title = '基準の設備（成形機など）を動かす・回す・複製すると、つないだ付帯設備（ユニット）も一緒に動く。外すと選んだ設備だけ'
  const unitBox = document.createElement('input')
  unitBox.type = 'checkbox'
  unitBox.checked = unitMode
  unitBox.addEventListener('change', () => {
    unitMode = unitBox.checked
    try {
      localStorage.setItem(UNIT_MODE_KEY, unitMode ? 'on' : 'off')
    } catch {
      // 覚えておけなくても、開いている間は効く
    }
    unitBox.blur()
    render()
  })
  unitLabel.append(unitBox, 'ユニットごと')
  const dup = mkAction('複製', '選択中の設備を写して右隣に置く（余白の分だけ離す。Ctrl+D）', duplicateSelection)
  const del = mkAction('削除', '選択中の設備を消す（Delete）', removeSelection)
  actions.append(unitLabel)
  // 選択中の設備の名前・寸法・色。値を確定したとき（change）に update のコマンドを 1 回出す
  const props = document.createElement('div')
  props.className = 'props'
  const mkProp = (label: string, input: HTMLInputElement) => {
    const l = document.createElement('label')
    l.append(label, input)
    props.append(l)
    return l
  }
  const nameInput = document.createElement('input')
  nameInput.type = 'text'
  const widthInput = document.createElement('input')
  const depthInput = document.createElement('input')
  for (const i of [widthInput, depthInput]) {
    i.type = 'number'
    i.min = '1'
    i.step = '10'
  }
  const colorInput = document.createElement('input')
  colorInput.type = 'color'
  const nameRow = mkProp('名前', nameInput)
  const widthRow = mkProp('幅 mm', widthInput)
  const depthRow = mkProp('奥行 mm', depthInput)
  mkProp('色', colorInput)
  // 余白は上・右・下・左（回転 0 のときの向き。設備と一緒に回る）。複数を選んでいれば、変えた辺だけまとめて変える
  const SIDES: { key: keyof Clearance; label: string }[] = [
    { key: 'top', label: '上' },
    { key: 'right', label: '右' },
    { key: 'bottom', label: '下' },
    { key: 'left', label: '左' },
  ]
  const clearanceInputs = new Map<keyof Clearance, HTMLInputElement>()
  const clearanceRow = document.createElement('label')
  clearanceRow.className = 'clearance-row'
  clearanceRow.title = '保守用の余白（mm）。回転 0 のときの上・右・下・左の辺から外へ取る幅で、設備と一緒に回る。上は向きの印の側'
  const clearanceBox = document.createElement('span')
  clearanceBox.className = 'clearance-inputs'
  for (const { key, label } of SIDES) {
    const i = document.createElement('input')
    i.type = 'number'
    i.min = '0'
    i.step = '100'
    i.title = `余白の${label}（mm）`
    i.addEventListener('change', () => {
      if (i.value === '') return
      updateSelection({ clearance: { [key]: Number(i.value) } })
    })
    i.addEventListener('focus', () => (editIds = liveSelection()))
    i.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') i.blur()
    })
    const cell = document.createElement('span')
    cell.append(label, i)
    clearanceBox.append(cell)
    clearanceInputs.set(key, i)
  }
  clearanceRow.append('余白 mm', clearanceBox)
  props.append(clearanceRow)
  nameInput.addEventListener('change', () => updateSelection({ name: nameInput.value }))
  widthInput.addEventListener('change', () => updateSelection({ width: Number(widthInput.value) }))
  depthInput.addEventListener('change', () => updateSelection({ depth: Number(depthInput.value) }))
  colorInput.addEventListener('change', () => updateSelection({ color: colorInput.value }))
  for (const i of [nameInput, widthInput, depthInput, colorInput])
    i.addEventListener('focus', () => (editIds = liveSelection()))
  // Enter で確定して、キャンバスのキー操作に戻る
  for (const i of [nameInput, widthInput, depthInput])
    i.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') i.blur()
    })
  const msg = document.createElement('div')
  msg.className = 'message'
  const keys = document.createElement('div')
  keys.className = 'keys'
  keys.textContent =
    'クリック: 選ぶ　Shift+クリック: 足す・外す　ドラッグ: 動かす　R / Shift+R: 回す　矢印: スナップ幅ずつ動かす　Ctrl+D: 複製　Delete: 消す　Ctrl+Z / Ctrl+Y: 元に戻す / やり直す　Esc: やめる'
  // 重なりの一覧。行をクリックすると、かかわる設備を選ぶ
  const h3 = document.createElement('h2')
  h3.textContent = '重なり'
  const overlapInfo = document.createElement('div')
  overlapInfo.className = 'info'
  const overlapList = document.createElement('ul')
  overlapList.className = 'overlap-list'
  side.append(h1, list, h2, info, props, actions, msg, h3, overlapInfo, overlapList, keys)

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
    if (scene().templates !== builtFor) {
      buildTemplateList(scene().templates)
      syncPlacing()
    }
    // ドラッグ中は、移動のコマンドを仮に当てた結果を見せる（履歴には積まない）
    let shown = scene()
    if (mode.type === 'dragging' && mode.moved) {
      const r = applyCommand(shown, { type: 'move', ids: mode.ids, dx: mode.dx, dy: mode.dy })
      if (r.ok) shown = r.scene
    } else if (mode.type === 'grab' && mode.moved && mode.cmd) {
      const r = applyCommand(shown, mode.cmd)
      if (r.ok) shown = r.scene
    }
    lastShown = shown
    selected = liveSelection()
    const sel = new Set(selected)
    // 敷地からはみ出した設備。ドラッグ中は動かした先で判定する
    const outside = new Set(equipmentOutsideSite(shown))
    // 重なり。置く途中は、置く先の設備（id は空）も入れて判定する
    const placed = mode.type === 'placing' && pointer ? ghost(mode, pointer) : null
    const overlaps = findOverlaps(placed ? { ...shown, equipment: [...shown.equipment, placed] } : shown)
    const overlapping = overlappingEquipment(overlaps)
    const inClearance = clearanceEquipment(overlaps)
    // ユニットごとなら、選んだ基準の設備のユニットの付帯設備を、一緒に動くものとして薄く示す
    const units = unitMode ? unitsOf(shown) : null
    const members = new Set(units ? selected.flatMap((id) => units.get(id) ?? []).filter((id) => !sel.has(id)) : [])
    const cls = (eq: Equipment) =>
      `${sel.has(eq.id) ? ' selected' : ''}${members.has(eq.id) ? ' unit-member' : ''}${outside.has(eq.id) ? ' outside' : ''}${overlapping.has(eq.id) ? ' overlap' : ''}` +
      `${inClearance.has(eq.id) ? ' in-clearance' : ''}`
    const all = placed ? [...shown.equipment, placed] : shown.equipment
    clearanceLayer.replaceChildren(...all.flatMap((eq) => drawClearance(eq, sel.has(eq.id) || eq === placed)))
    layer.replaceChildren(...shown.equipment.map((eq) => drawEquipment(eq, `equipment${cls(eq)}`)))
    if (placed) layer.append(drawEquipment(placed, `equipment ghost${cls(placed)}`))
    overlapLayer.replaceChildren(...overlaps.filter((o) => o.kind !== 'clearance').flatMap(drawOverlap))
    clearanceHitLayer.replaceChildren(...overlaps.filter((o) => o.kind === 'clearance').flatMap(drawOverlap))
    renderOverlapList(shown, overlaps)
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
      info.textContent =
        `${e.name}　${e.width} × ${e.depth} mm、${e.rotation}°　中心 (${Math.round(e.x)}, ${Math.round(e.y)})　左上 (${Math.round(fp.x)}, ${Math.round(fp.y)})` +
        (outside.has(e.id) ? '　敷地からはみ出し' : '') +
        (overlapping.has(e.id) ? `　重なり: ${partners(shown, overlaps, e.id).join('、')}` : '') +
        (inClearance.has(e.id) ? `　余白: ${clearancePartners(shown, overlaps, e.id).join('、')}` : '')
    } else if (items.length > 1) {
      const out = items.filter((e) => outside.has(e.id)).length
      const ov = items.filter((e) => overlapping.has(e.id)).length
      const cl = items.filter((e) => inClearance.has(e.id)).length
      const notes = [out ? `${out} 台が敷地からはみ出し` : '', ov ? `${ov} 台が重なり` : '', cl ? `${cl} 台が余白にかかわる` : ''].filter(Boolean)
      info.textContent = `${items.length} 台${notes.length ? `（うち ${notes.join('、')}）` : ''}`
    } else {
      info.textContent = 'なし'
    }
    for (const b of [rotLeft, rotRight, dup, del]) b.disabled = items.length === 0
    // 名前と寸法は 1 台のときだけ。色は複数でもまとめて変えられる
    props.hidden = items.length === 0 || mode.type === 'placing'
    for (const r of [nameRow, widthRow, depthRow]) r.hidden = items.length !== 1
    const first = items[0]
    const setValue = (i: HTMLInputElement, v: string) => {
      if (document.activeElement !== i) i.value = v
    }
    if (first) {
      setValue(nameInput, first.name)
      setValue(widthInput, String(first.width))
      setValue(depthInput, String(first.depth))
      setValue(colorInput, items.every((e) => e.color === first.color) && /^#[0-9a-f]{6}$/i.test(first.color) ? first.color : '#000000')
      // 複数を選んで値がそろわない辺は空にする
      for (const [key, i] of clearanceInputs) {
        const v = first.clearance[key]
        setValue(i, items.every((e) => e.clearance[key] === v) ? String(v) : '')
        i.placeholder = items.length > 1 ? '—' : ''
      }
    }
    undoBtn.disabled = !canUndo(history)
    redoBtn.disabled = !canRedo(history)
    msg.textContent = message
    for (const f of listeners) f()
  }

  // 重なっている部分の図形
  function drawOverlap(o: Overlap): SVGElement[] {
    const rect = (q: { x: number; y: number; width: number; height: number }) => {
      const r = document.createElementNS(SVG_NS, 'rect')
      for (const [k, v] of Object.entries({ x: q.x, y: q.y, width: q.width, height: q.height })) r.setAttribute(k, String(v))
      return r
    }
    if (o.kind === 'equipment') return [rect(o.region)]
    if (o.kind === 'clearance') return o.regions.map(rect)
    return o.regions.map((poly) => {
      const p = document.createElementNS(SVG_NS, 'polygon')
      p.setAttribute('points', poly.map((q) => `${q.x},${q.y}`).join(' '))
      return p
    })
  }

  // 余白の範囲（本体を含めて囲む長方形）。余白が無ければ描かない
  function drawClearance(eq: Equipment, strong: boolean): SVGElement[] {
    const c = eq.clearance
    if (c.top === 0 && c.right === 0 && c.bottom === 0 && c.left === 0) return []
    const q = clearanceRect(eq)
    const r = document.createElementNS(SVG_NS, 'rect')
    for (const [k, v] of Object.entries({ x: q.x, y: q.y, width: q.width, height: q.height })) r.setAttribute(k, String(v))
    r.setAttribute('class', strong ? 'clearance-zone selected' : 'clearance-zone')
    r.setAttribute('fill', eq.color)
    r.setAttribute('stroke', eq.color)
    return [r]
  }

  // 設備 id の余白への入り込みの相手（「成形機 1 の余白に入る」「取出機 1 が入っている」）
  function clearancePartners(s: Scene, overlaps: readonly Overlap[], id: string): string[] {
    const out: string[] = []
    for (const o of overlaps) {
      if (o.kind !== 'clearance') continue
      if (o.equipment === id) out.push(`${equipmentName(s, o.owner)}の余白に入る`)
      if (o.owner === id) out.push(`${equipmentName(s, o.equipment)}が入っている`)
    }
    return out
  }

  // 設備 id と重なっている相手の名前（設備、続いて通路）
  function partners(s: Scene, overlaps: readonly Overlap[], id: string): string[] {
    const out: string[] = []
    for (const o of overlaps) {
      if (o.kind === 'equipment' && (o.a === id || o.b === id)) out.push(equipmentName(s, o.a === id ? o.b : o.a))
      if (o.kind === 'aisle' && o.equipment === id) out.push(s.aisles.find((a) => a.id === o.aisle)?.name ?? o.aisle)
    }
    return out
  }
  const equipmentName = (s: Scene, id: string) =>
    id === '' && mode.type === 'placing' ? `置く${mode.template.name}` : (s.equipment.find((e) => e.id === id)?.name ?? id)

  // 左の欄の重なりの一覧。多いときは先頭だけ出す
  const OVERLAP_ROWS = 20
  function renderOverlapList(s: Scene, overlaps: readonly Overlap[]) {
    const nEq = overlaps.filter((o) => o.kind === 'equipment').length
    const nAisle = overlaps.filter((o) => o.kind === 'aisle').length
    const nClear = overlaps.length - nEq - nAisle
    overlapInfo.textContent = overlaps.length
      ? [nEq ? `設備どうし ${nEq} 件` : '', nAisle ? `設備と通路 ${nAisle} 件` : '', nClear ? `余白への入り込み ${nClear} 件` : '']
          .filter(Boolean)
          .join('、')
      : 'なし'
    overlapInfo.classList.toggle('warn', overlaps.length > 0)
    overlapList.replaceChildren(
      ...overlaps.slice(0, OVERLAP_ROWS).map((o) => {
        const li = document.createElement('li')
        const ids = o.kind === 'equipment' ? [o.a, o.b] : o.kind === 'clearance' ? [o.equipment, o.owner] : [o.equipment]
        if (o.kind === 'clearance') li.className = 'clearance'
        li.textContent =
          o.kind === 'equipment'
            ? `${equipmentName(s, o.a)} と ${equipmentName(s, o.b)}`
            : o.kind === 'clearance'
              ? `${equipmentName(s, o.equipment)} が ${equipmentName(s, o.owner)} の余白に`
              : `${equipmentName(s, o.equipment)} と ${s.aisles.find((a) => a.id === o.aisle)?.name ?? o.aisle}`
        li.title = 'クリックでこの設備を選ぶ'
        li.addEventListener('click', () => {
          const live = ids.filter((id) => scene().equipment.some((e) => e.id === id))
          if (live.length && mode.type === 'idle') {
            selected = live
            render()
          }
        })
        return li
      }),
    )
    if (overlaps.length > OVERLAP_ROWS) {
      const li = document.createElement('li')
      li.className = 'more'
      li.textContent = `ほか ${overlaps.length - OVERLAP_ROWS} 件`
      overlapList.append(li)
    }
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

  // ---- マウスと指 ----
  // 指で触る画面の決まり: 選んでいる設備・つかめる頂点は指で動かす。それ以外は、動かすと画面の移動、
  // 動かさずに離すとマウスのクリックと同じ（選ぶ・置く・道具の点を拾う）。2 本指は canvas の拡大縮小と移動
  const svgEl = canvas.svg
  // 画面はまだ動かさない。触って離すつもりの指の揺れで図面がずれないよう、TOUCH_SLOP_PX を超えてから動かす
  const startTouchTap = (e: PointerEvent, tap: () => void) => {
    touchTap = { pointerId: e.pointerId, startClient: { x: e.clientX, y: e.clientY }, moved: false, tap }
  }
  const onTouchDown = (e: PointerEvent, at: Point) => {
    if (mode.type === 'tool') {
      const tool = mode.tool
      startTouchTap(e, () => {
        if (mode.type !== 'tool' || mode.tool !== tool) return
        pointer = at
        tool.pointerDown(at, e)
        render()
      })
      return
    }
    if (mode.type === 'placing') {
      startTouchTap(e, () => {
        if (mode.type !== 'placing') return
        const m = mode
        const eq = { ...ghost(m, at), id: nextEquipmentId(scene()), name: nextEquipmentName(scene(), m.template) }
        setMode({ type: 'idle' })
        if (run({ type: 'add', equipment: eq })) selected = [eq.id]
        render()
      })
      return
    }
    for (const f of grabListeners) {
      const grab = f(at, e)
      if (!grab) continue
      if (grab.panOnTouch) {
        startTouchTap(e, () => {
          grab.click?.()
          render()
        })
        return
      }
      mode = { type: 'grab', pointerId: e.pointerId, startClient: { x: e.clientX, y: e.clientY }, grab, cmd: null, moved: false }
      render()
      return
    }
    const hit = hitTest(scene(), at)
    if (hit && !multi && selected.includes(hit)) {
      mode = {
        type: 'dragging',
        pointerId: e.pointerId,
        startClient: { x: e.clientX, y: e.clientY },
        startWorld: at,
        grabId: hit,
        ids: expand([...selected]),
        dx: 0,
        dy: 0,
        moved: false,
      }
      render()
      return
    }
    startTouchTap(e, () => {
      if (mode.type !== 'idle') return
      if (!hit) {
        if (!multi) selected = []
        for (const f of emptyClickListeners) f(at, e)
      } else if (multi) {
        selected = selected.includes(hit) ? selected.filter((id) => id !== hit) : [...selected, hit]
      } else {
        selected = [hit]
      }
      render()
    })
  }
  // 2 本目の指が触れたら、1 本指で始めた操作は当てずにやめる
  canvas.onPinch(() => {
    touchTap = null
    if (mode.type === 'dragging' || mode.type === 'grab') {
      mode = { type: 'idle' }
      svgEl.classList.remove('dragging')
      render()
    }
  })
  svgEl.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') {
      if (canvas.touchCount() > 1 || e.button !== 0) return
      onTouchDown(e, canvas.toWorld(e.clientX, e.clientY))
      return
    }
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
    for (const f of grabListeners) {
      const grab = f(at, e)
      if (!grab) continue
      mode = { type: 'grab', pointerId: e.pointerId, startClient: { x: e.clientX, y: e.clientY }, grab, cmd: null, moved: false }
      svgEl.setPointerCapture(e.pointerId)
      render()
      return
    }
    const hit = hitTest(scene(), at)
    const adding = e.shiftKey || multi
    if (!hit) {
      if (!adding) selected = []
      for (const f of emptyClickListeners) f(at, e)
      render()
      return
    }
    if (adding) {
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
      ids: expand([...selected]),
      dx: 0,
      dy: 0,
      moved: false,
    }
    svgEl.setPointerCapture(e.pointerId)
    render()
  })

  const slop = (e: PointerEvent) => (e.pointerType === 'touch' ? TOUCH_SLOP_PX : DRAG_THRESHOLD_PX)
  svgEl.addEventListener('pointermove', (e) => {
    if (touchTap && e.pointerId === touchTap.pointerId) {
      if (!touchTap.moved && Math.hypot(e.clientX - touchTap.startClient.x, e.clientY - touchTap.startClient.y) > TOUCH_SLOP_PX) {
        touchTap.moved = true
        canvas.beginPan(touchTap.pointerId, touchTap.startClient)
      }
      return
    }
    const at = canvas.toWorld(e.clientX, e.clientY)
    // 指には「今さしている所」が無いので、置く設備の影や道具の線を指に付いてこさせない
    if (e.pointerType !== 'touch') pointer = at
    if (mode.type === 'dragging' && e.pointerId === mode.pointerId) {
      const far = Math.hypot(e.clientX - mode.startClient.x, e.clientY - mode.startClient.y) > slop(e)
      if (!mode.moved && !far) return
      const grabId = mode.grabId
      const grab = scene().equipment.find((x) => x.id === grabId)
      if (!grab) return
      // つかんだ設備を基準にスナップし、選んだ設備をすべて同じだけ動かす
      const d = snapMove(grab, at.x - mode.startWorld.x, at.y - mode.startWorld.y, snap)
      mode = { ...mode, dx: d.dx, dy: d.dy, moved: true }
      svgEl.classList.add('dragging')
      render()
    } else if (mode.type === 'grab' && e.pointerId === mode.pointerId) {
      const far = Math.hypot(e.clientX - mode.startClient.x, e.clientY - mode.startClient.y) > slop(e)
      if (!mode.moved && !far) return
      mode = { ...mode, cmd: mode.grab.move(at, e), moved: true }
      svgEl.classList.add('dragging')
      render()
    } else if (mode.type === 'placing' || mode.type === 'tool') {
      render()
    }
  })

  const endDrag = (e: PointerEvent, commit: boolean) => {
    if (touchTap && e.pointerId === touchTap.pointerId) {
      const t = touchTap
      touchTap = null
      if (commit && !t.moved) t.tap()
      return
    }
    if (mode.type === 'grab' && e.pointerId === mode.pointerId) {
      const m = mode
      mode = { type: 'idle' }
      svgEl.classList.remove('dragging')
      if (commit && m.moved && m.cmd) {
        const ok = run(m.cmd)
        m.grab.end?.(ok)
        if (ok) render()
      } else {
        if (commit && !m.moved) m.grab.click?.()
        render()
      }
      return
    }
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
    if (isInteractive(e.target) || mode.type === 'dragging' || mode.type === 'grab') return
    const mod = e.ctrlKey || e.metaKey
    if (mod && !e.altKey) {
      const k = e.key.toLowerCase()
      if (k === 'd' && !e.shiftKey && mode.type !== 'tool') duplicateSelection()
      else if (k === 'z' && !e.shiftKey) doUndo()
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

  const resetListeners: (() => void)[] = []
  const restore = (next: History) => {
    setMode({ type: 'idle' })
    history = next
    selected = []
    message = ''
    for (const f of resetListeners) f()
    render()
  }

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
    reset: (next) => restore(createHistory(next)),
    history: () => history,
    restore,
    onReset: (f) => resetListeners.push(f),
    snapStep: () => snap,
    selection: () => liveSelection(),
    select: (ids) => {
      selected = ids
      render()
    },
    claimSelection: (owner) => {
      selected = []
      for (const f of claimListeners) f(owner)
      render()
    },
    onClaim: (f) => claimListeners.push(f),
    onEmptyClick: (f) => emptyClickListeners.push(f),
    onGrab: (f) => grabListeners.push(f),
    multiSelect: () => multi,
    setMultiSelect: (on) => {
      multi = on
      render()
    },
    shown: () => lastShown ?? scene(),
  }
}
