// AGV の通路: クリックで中心線のポリラインを描く、選ぶ、名前・幅を変える、消す。
// 選んだ通路の頂点を動かす・足す・消す、通路ごと動かす（ドラッグと矢印キー）。
// シーンの変更は editor.run（コマンド）を通す。描いている途中の頂点と、通路・頂点の選択は画面の状態で、シーンには入れない。
import type { Canvas } from './canvas'
import type { Editor, Grab, Tool } from './editor'
import {
  DEFAULT_AISLE_WIDTH,
  aisleHitTest,
  aisleLength,
  aisleMidpoints,
  aisleVertexAt,
  insertAisleVertex,
  moveAisleVertex,
  nextAisleId,
  nextAisleName,
  removeAisleVertex,
  type Aisle,
} from '../core/aisle'
import { hitTest, snapValue } from '../core/placement'
import type { Point } from '../core/viewport'

const SVG_NS = 'http://www.w3.org/2000/svg'
// 最初の頂点（または直前の頂点）からこの px 以内をクリックしたら、閉じる・終える
const CLOSE_PX = 8
const MARK_PX = 4
// 細い通路でもクリックで選べるよう、幅の外にこの px の余裕を持たせる
const HIT_SLACK_PX = 4
// 選んだ通路の頂点と、線分の中点（頂点を足すつまみ）の大きさと、つかめる範囲（px）
const HANDLE_PX = 10
const MID_PX = 7
const GRAB_PX = 7
// 指は先が太いので、当たりの幅をこれだけ広げる
const TOUCH_REACH = 2.5
// スナップしないときの矢印キー 1 回の移動量
const NUDGE_NO_SNAP = 10

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v))
  return el
}

// Shift を押している間は、直前の頂点から水平か垂直に限る
function constrain(a: Point | undefined, p: Point, on: boolean): Point {
  if (!on || !a) return p
  return Math.abs(p.x - a.x) >= Math.abs(p.y - a.y) ? { x: p.x, y: a.y } : { x: a.x, y: p.y }
}

const pathOf = (pts: readonly Point[], close: boolean) =>
  pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join('') + (close && pts.length > 2 ? 'Z' : '')
const fmtM = (mm: number) => `${(mm / 1000).toLocaleString('ja-JP', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} m`

// 一方通行の矢印の間隔（mm）。辺ごとに少なくとも 1 つ、辺の中ほどに置く
const ARROW_PITCH = 5000

// 一方通行の向きの矢印（く の字）。大きさは通路の幅に合わせる
function arrowsPath(a: Pick<Aisle, 'points' | 'width' | 'closed'>): string {
  const pts = a.closed && a.points.length > 2 ? [...a.points, a.points[0]!] : a.points
  const r = a.width * 0.3
  let d = ''
  for (let i = 0; i + 1 < pts.length; i++) {
    const p = pts[i]!
    const q = pts[i + 1]!
    const len = Math.hypot(q.x - p.x, q.y - p.y)
    if (len < r * 2) continue
    const ux = (q.x - p.x) / len
    const uy = (q.y - p.y) / len
    const n = Math.max(1, Math.floor(len / ARROW_PITCH))
    for (let k = 0; k < n; k++) {
      const t = (len * (k + 0.5)) / n
      const tip = { x: p.x + ux * (t + r / 2), y: p.y + uy * (t + r / 2) }
      const bx = tip.x - ux * r
      const by = tip.y - uy * r
      d += `M${bx - uy * r} ${by + ux * r}L${tip.x} ${tip.y}L${bx + uy * r} ${by - ux * r}`
    }
  }
  return d
}

// 通路の帯（幅を太さにした線）と中心線。一方通行なら向きの矢印
function drawAisle(a: Pick<Aisle, 'points' | 'width' | 'closed' | 'oneWay'>, cls: string): SVGGElement {
  const g = svg('g', { class: cls })
  const d = pathOf(a.points, a.closed)
  g.append(svg('path', { class: 'aisle-body', d, 'stroke-width': a.width }), svg('path', { class: 'aisle-center', d }))
  if (a.oneWay) g.append(svg('path', { class: 'aisle-arrow', d: arrowsPath(a) }))
  return g
}

// 画面の上で決まった大きさの点（拡大縮小しても px が変わらない）。長さ 0 の線を太い線端で描く。縁取りと中の 2 重
function handle(p: Point, px: number, cls: string, square: boolean): SVGGElement {
  const cap = square ? 'square' : 'round'
  const d = `M${p.x} ${p.y}h0`
  const g = svg('g', { class: cls })
  g.append(svg('path', { class: 'edge', d, 'stroke-width': px, 'stroke-linecap': cap }), svg('path', { class: 'core', d, 'stroke-width': px - 4, 'stroke-linecap': cap }))
  return g
}

export function mountAisles(canvas: Canvas, editor: Editor): void {
  // 敷地より上、設備より下に描く
  const layer = svg('g', { class: 'aisle-layer' })
  canvas.world.insertBefore(layer, canvas.world.querySelector('.equipment-layer'))
  // 選んだ通路の頂点のつまみ。設備に隠れないよう、いちばん上に描く
  const handleLayer = svg('g', { class: 'aisle-handle-layer' })
  canvas.world.append(handleLayer)
  let selected: string[] = []
  // 選んだ通路の中で選んでいる頂点（Delete で消す）
  let vertex: number | null = null

  // ---- 左の欄 ----
  const h = document.createElement('h2')
  h.textContent = 'AGV の通路'
  const box = document.createElement('div')
  box.className = 'aisle-panel'
  const info = document.createElement('div')
  info.className = 'info'
  const drawForm = document.createElement('form')
  drawForm.className = 'aisle-draw-form'
  drawForm.noValidate = true
  const nextWidth = document.createElement('input')
  nextWidth.type = 'number'
  nextWidth.min = '1'
  nextWidth.step = '100'
  nextWidth.value = String(DEFAULT_AISLE_WIDTH)
  nextWidth.title = 'これから描く通路の幅（mm）'
  const drawBtn = document.createElement('button')
  drawBtn.type = 'submit'
  drawBtn.textContent = '通路を描く'
  drawBtn.title = 'クリックで中心線の頂点を置き、Enter かダブルクリックで終える。最初の頂点をクリックすると周回になる'
  drawForm.append('幅 ', nextWidth, ' mm ', drawBtn)

  // 選択中の通路の名前・幅。値を確定したとき（change）に updateAisle を 1 回出す
  const props = document.createElement('div')
  props.className = 'props'
  const mkProp = (label: string, input: HTMLInputElement) => {
    const l = document.createElement('label')
    l.append(label, input)
    props.append(l)
  }
  const nameInput = document.createElement('input')
  nameInput.type = 'text'
  const widthInput = document.createElement('input')
  widthInput.type = 'number'
  widthInput.min = '1'
  widthInput.step = '100'
  mkProp('名前', nameInput)
  mkProp('幅 mm', widthInput)
  // 一方通行と、その向き（頂点の順）を逆にする
  const oneWayRow = document.createElement('div')
  oneWayRow.className = 'actions'
  const oneWayLabel = document.createElement('label')
  const oneWayInput = document.createElement('input')
  oneWayInput.type = 'checkbox'
  oneWayLabel.title = 'AGV は頂点の順（描いた順）にだけ走る'
  oneWayLabel.append(oneWayInput, ' 一方通行')
  const reverseBtn = document.createElement('button')
  reverseBtn.type = 'button'
  reverseBtn.textContent = '向きを逆に'
  reverseBtn.title = '頂点の順を逆にする（一方通行の向きが変わる）'
  oneWayRow.append(oneWayLabel, reverseBtn)
  props.append(oneWayRow)
  const row = document.createElement('div')
  row.className = 'actions'
  const delBtn = document.createElement('button')
  delBtn.type = 'button'
  delBtn.textContent = '通路を消す'
  delBtn.title = '選択中の通路を消す（Delete。元に戻すで戻せる）'
  row.append(delBtn)
  const hint = document.createElement('div')
  hint.className = 'hint'
  const selInfo = document.createElement('div')
  selInfo.className = 'info'
  const editHint = document.createElement('div')
  editHint.className = 'hint'
  editHint.textContent =
    '頂点をドラッグで動かす。辺の中点をドラッグかクリックで頂点を足す。頂点をクリックして Delete で消す。帯のドラッグか矢印キーで通路ごと動かす'
  box.append(info, drawForm, selInfo, props, row, editHint, hint)

  // 敷地の欄の下、ひな形の上に置く
  const templatesHeading = canvas.side.querySelector('h2 + .templates')?.previousElementSibling
  if (templatesHeading) canvas.side.insertBefore(h, templatesHeading)
  else canvas.side.append(h)
  h.after(box)

  // 案の切り替えやファイルの読み込みで、別のシーンの同じ id の通路を選んだままにしない
  editor.onReset(() => {
    selected = []
    vertex = null
  })
  // つなぎを選んだら通路の選択を外す
  editor.onClaim((owner) => {
    if (owner === 'aisle') return
    selected = []
    vertex = null
  })

  const liveSelection = () => selected.filter((id) => editor.scene().aisles.some((a) => a.id === id))
  const select = (ids: string[]) => {
    selected = ids
    vertex = null
    editor.render()
  }

  // 欄に入った時点の選択に当てる（入力中にキャンバスで選び直しても、確定は入力を始めた通路に行く）
  let editIds: string[] = []
  for (const i of [nameInput, widthInput]) {
    i.addEventListener('focus', () => (editIds = liveSelection()))
    i.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') i.blur()
    })
  }
  const updateSelection = (changes: { name?: string; width?: number; oneWay?: boolean }) => {
    const ids = (editIds.length ? editIds : liveSelection()).filter((id) => editor.scene().aisles.some((a) => a.id === id))
    if (ids.length) editor.run({ type: 'updateAisle', ids, changes })
  }
  nameInput.addEventListener('change', () => updateSelection({ name: nameInput.value }))
  widthInput.addEventListener('change', () => updateSelection({ width: Number(widthInput.value) }))
  oneWayInput.addEventListener('change', () => {
    editIds = liveSelection()
    updateSelection({ oneWay: oneWayInput.checked })
  })
  reverseBtn.addEventListener('click', () => {
    const a = selectedAisle()
    if (a) editor.run({ type: 'setAislePoints', id: a.id, points: [...a.points].reverse() })
  })
  const removeSelection = () => {
    const ids = liveSelection()
    if (ids.length && editor.run({ type: 'removeAisle', ids })) select([])
  }
  // 選んでいる頂点を消す。頂点が足りなくなるときはコマンドが断り、理由が下の欄に出る
  const removeVertex = () => {
    const a = selectedAisle()
    if (!a || vertex === null) return
    if (editor.run({ type: 'setAislePoints', id: a.id, points: removeAisleVertex(a.points, vertex) })) vertex = null
    editor.render()
  }
  const selectedAisle = (): Aisle | undefined => {
    const ids = liveSelection()
    return ids.length === 1 ? editor.scene().aisles.find((a) => a.id === ids[0]) : undefined
  }
  delBtn.addEventListener('click', removeSelection)

  // ---- 選ぶ: 設備の無い所のクリックで、通路に当たれば選ぶ ----
  editor.onEmptyClick((at, e) => {
    const reach = e.pointerType === 'touch' ? TOUCH_REACH : 1
    const hit = aisleHitTest(editor.scene(), at, (HIT_SLACK_PX * reach) / canvas.getViewport().scale)
    // 設備・通路・つなぎは同時に選ばない
    if (hit) editor.claimSelection('aisle')
    selected = hit ? [hit] : []
    vertex = null
  })

  // ---- 頂点を動かす・足す、通路ごと動かす（ドラッグ） ----
  const snapPoint = (p: Point) => {
    const step = editor.snapStep()
    return { x: snapValue(p.x, step), y: snapValue(p.y, step) }
  }
  // 頂点 i を動かす。Shift で前の頂点（先頭なら次の頂点）から水平・垂直に限る
  const vertexGrab = (a: Aisle, i: number): Grab => {
    const anchor = a.points[i - 1] ?? (a.closed ? a.points[a.points.length - 1] : a.points[1])
    return {
      move: (at, e) => ({ type: 'setAislePoints', id: a.id, points: moveAisleVertex(a.points, i, constrain(anchor, snapPoint(at), e.shiftKey)) }),
      click: () => (vertex = i),
      end: (ok) => {
        if (ok) vertex = i
      },
    }
  }
  // 線分 seg の中点をつかんで、頂点を足しながら動かす。動かさずに離したら中点に足す
  const insertGrab = (a: Aisle, seg: number, mid: Point): Grab => ({
    move: (at, e) => ({ type: 'setAislePoints', id: a.id, points: insertAisleVertex(a.points, seg, constrain(a.points[seg], snapPoint(at), e.shiftKey)) }),
    click: () => {
      if (editor.run({ type: 'setAislePoints', id: a.id, points: insertAisleVertex(a.points, seg, mid) })) vertex = seg + 1
    },
    end: (ok) => {
      if (ok) vertex = seg + 1
    },
  })
  // 通路ごと動かす。最初の頂点がスナップの間隔に乗るように動かす
  const moveGrab = (a: Aisle, start: Point): Grab => {
    const p0 = a.points[0]!
    return {
      move: (at) => {
        const to = snapPoint({ x: p0.x + at.x - start.x, y: p0.y + at.y - start.y })
        return { type: 'moveAisle', ids: [a.id], dx: to.x - p0.x, dy: to.y - p0.y }
      },
    }
  }
  editor.onGrab((at, e) => {
    const touch = e.pointerType === 'touch'
    const s = scale() / (touch ? TOUCH_REACH : 1)
    const a = selectedAisle()
    if (a && !e.shiftKey) {
      const i = aisleVertexAt(a, at, GRAB_PX / s)
      if (i !== null) return vertexGrab(a, i)
      const mids = aisleMidpoints(a)
      const seg = aisleVertexAt({ ...a, points: mids }, at, GRAB_PX / s)
      if (seg !== null) return insertGrab(a, seg, mids[seg]!)
    }
    // 設備が上にあれば設備を先に当てる。Shift は設備の選び足しに使うので引き受けない
    const scene = editor.scene()
    if (e.shiftKey || hitTest(scene, at)) return null
    const hit = aisleHitTest(scene, at, HIT_SLACK_PX / s)
    const target = scene.aisles.find((x) => x.id === hit)
    if (!target) return null
    // 指では、選んでいない通路は動かさない（触って離したら選ぶ、動かしたら画面の移動）
    if (touch && !selected.includes(target.id)) {
      return {
        move: () => null,
        panOnTouch: true,
        click: () => {
          editor.claimSelection('aisle')
          select([target.id])
        },
      }
    }
    editor.claimSelection('aisle')
    if (!selected.includes(target.id)) select([target.id])
    else vertex = null
    return moveGrab(target, at)
  })

  // ---- 通路を描く道具 ----
  let pts: Point[] = []
  let width = DEFAULT_AISLE_WIDTH
  let shift = false
  const scale = () => canvas.getViewport().scale
  const candidate = (at: Point, shiftKey: boolean): Point => {
    const step = editor.snapStep()
    return constrain(pts[pts.length - 1], { x: snapValue(at.x, step), y: snapValue(at.y, step) }, shiftKey)
  }
  const near = (a: Point | undefined, b: Point) => !!a && Math.hypot(a.x - b.x, a.y - b.y) * scale() <= CLOSE_PX
  const showProgress = () => {
    const len = pts.length >= 2 ? `　長さ ${fmtM(aisleLength({ points: pts, closed: false } as Aisle))}` : ''
    hint.textContent =
      `頂点 ${pts.length}${len}。` +
      (pts.length >= 2 ? 'Enter かダブルクリックで終える。最初の頂点をクリックで周回。' : 'クリックで頂点を置く。') +
      'Shift で水平・垂直、Backspace で 1 つ戻す、Esc でやめる'
  }
  const finish = (closed: boolean) => {
    if (pts.length < (closed ? 3 : 2)) return
    const scene = editor.scene()
    const aisle: Aisle = { id: nextAisleId(scene), name: nextAisleName(scene), points: pts, width, closed }
    if (editor.run({ type: 'addAisle', aisle })) {
      editor.endTool(drawTool)
      hint.textContent = `${aisle.name}を描きました（${closed ? '周回、' : ''}長さ ${fmtM(aisleLength(aisle))}）`
      select([aisle.id])
    } else {
      hint.textContent = '描けませんでした（理由は下の欄）。Backspace で頂点を戻して直してください'
    }
  }
  const drawTool: Tool = {
    pointerDown(at, e) {
      const p = candidate(at, e.shiftKey)
      if (pts.length >= 3 && near(pts[0], p)) return finish(true)
      // ダブルクリックの 2 回目（直前の頂点と同じ所）で終える
      if (near(pts[pts.length - 1], p)) {
        if (pts.length >= 2) finish(false)
        return
      }
      pts = [...pts, p]
      showProgress()
    },
    overlay(pointer) {
      const out: SVGElement[] = []
      const r = MARK_PX / scale()
      if (pts.length === 0) {
        if (pointer) {
          const p = candidate(pointer, false)
          out.push(svg('path', { class: 'pick-mark', d: `M${p.x - r} ${p.y}H${p.x + r}M${p.x} ${p.y - r}V${p.y + r}` }))
        }
        return out
      }
      const next = pointer ? candidate(pointer, shift) : null
      const closing = !!next && pts.length >= 3 && near(pts[0], next)
      const live = next && !closing ? [...pts, next] : pts
      out.push(drawAisle({ points: live, width, closed: closing }, 'aisle drawing'))
      for (const [i, p] of pts.entries())
        out.push(svg('circle', { class: i === 0 && closing ? 'aisle-vertex closing' : 'aisle-vertex', cx: p.x, cy: p.y, r: i === 0 && closing ? r * 2 : r }))
      return out
    },
    ended() {
      pts = []
      shift = false
      drawBtn.classList.remove('active')
      if (hint.textContent?.startsWith('頂点') || hint.textContent?.startsWith('描けません') || hint.textContent?.startsWith('クリック'))
        hint.textContent = ''
    },
  }
  drawForm.addEventListener('submit', (e) => {
    e.preventDefault()
    const w = Number(nextWidth.value)
    if (!(w > 0 && Number.isFinite(w))) {
      hint.textContent = '通路の幅は正の数（mm）にしてください'
      nextWidth.value = String(width)
      return
    }
    width = w
    selected = []
    editor.startTool(drawTool)
    drawBtn.classList.add('active')
    drawBtn.blur()
    pts = []
    hint.textContent = 'クリックで中心線の頂点を置く（スナップの間隔に乗る）。Esc でやめる'
  })
  const drawing = () => drawBtn.classList.contains('active')

  // ---- キー ----
  const isInteractive = (t: EventTarget | null) =>
    t instanceof HTMLElement && (t.isContentEditable || t.closest('input, select, textarea') !== null)
  window.addEventListener('keydown', (e) => {
    if (drawing()) {
      if (e.key === 'Shift') {
        shift = true
        editor.render()
        return
      }
      if (isInteractive(e.target)) return
      if (e.key === 'Enter') finish(false)
      else if (e.key === 'Backspace' || e.key === 'Delete') {
        pts = pts.slice(0, -1)
        showProgress()
        editor.render()
      } else return
      e.preventDefault()
      return
    }
    if (isInteractive(e.target) || e.ctrlKey || e.metaKey || e.altKey || liveSelection().length === 0) return
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
    const arrow = arrows[e.key]
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (vertex !== null) removeVertex()
      else removeSelection()
    } else if (e.key === 'Escape') {
      if (vertex !== null) {
        vertex = null
        editor.render()
      } else select([])
    } else if (arrow) {
      const step = editor.snapStep() > 0 ? editor.snapStep() : NUDGE_NO_SNAP
      editor.run({ type: 'moveAisle', ids: liveSelection(), dx: arrow[0] * step, dy: arrow[1] * step })
    } else return
    e.preventDefault()
  })
  window.addEventListener('keyup', (e) => {
    if (e.key === 'Shift' && drawing()) {
      shift = false
      editor.render()
    }
  })
  canvas.svg.addEventListener('pointermove', (e) => {
    shift = e.shiftKey
  })

  // ---- シーンに合わせて描き直す ----
  function paint() {
    const scene = editor.scene()
    // 設備を選んだら通路の選択は外す
    if (editor.selection().length > 0) selected = []
    selected = liveSelection()
    const sel = new Set(selected)
    // ドラッグ中は動かした先を描く
    const shown = editor.shown()
    layer.replaceChildren(...shown.aisles.map((a) => drawAisle(a, `aisle${sel.has(a.id) ? ' selected' : ''}`)))
    const one = selected.length === 1 ? shown.aisles.find((a) => a.id === selected[0]) : undefined
    if (!one || vertex === null || vertex >= one.points.length) vertex = null
    handleLayer.replaceChildren(
      ...(one && !drawing()
        ? [
            ...aisleMidpoints(one).map((p) => handle(p, MID_PX, 'aisle-handle mid', true)),
            ...one.points.map((p, i) => handle(p, HANDLE_PX, `aisle-handle${i === vertex ? ' active' : ''}`, false)),
          ]
        : []),
    )

    const total = scene.aisles.reduce((s, a) => s + aisleLength(a), 0)
    info.textContent = scene.aisles.length ? `${scene.aisles.length} 本　中心線の計 ${fmtM(total)}` : 'なし'
    const items = scene.aisles.filter((a) => sel.has(a.id))
    props.hidden = items.length !== 1
    row.hidden = items.length === 0
    selInfo.hidden = items.length !== 1
    editHint.hidden = items.length !== 1
    // 描いた直後の知らせは、通路の選択が外れたら消す
    if (items.length === 0 && hint.textContent?.includes('を描きました')) hint.textContent = ''
    const first = items[0]
    if (first) {
      if (document.activeElement !== nameInput) nameInput.value = first.name
      if (document.activeElement !== widthInput) widthInput.value = String(first.width)
      oneWayInput.checked = first.oneWay === true
      reverseBtn.disabled = first.oneWay !== true
      selInfo.textContent =
        `選択中: ${first.name}（${first.closed ? '周回、' : ''}${first.oneWay ? '一方通行、' : ''}頂点 ${first.points.length}、長さ ${fmtM(aisleLength(first))}）` +
        (vertex !== null ? `　頂点 ${vertex + 1} を選択中（Delete で消す）` : '')
    }
  }
  editor.onRender(paint)
  paint()
}
