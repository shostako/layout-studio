// AGV の通路: クリックで中心線のポリラインを描く、選ぶ、名前・幅を変える、消す。
// シーンの変更は editor.run（コマンド）を通す。描いている途中の頂点と、通路の選択は画面の状態で、シーンには入れない。
import type { Canvas } from './canvas'
import type { Editor, Tool } from './editor'
import { DEFAULT_AISLE_WIDTH, aisleHitTest, aisleLength, nextAisleId, nextAisleName, type Aisle } from '../core/aisle'
import { snapValue } from '../core/placement'
import type { Point } from '../core/viewport'

const SVG_NS = 'http://www.w3.org/2000/svg'
// 最初の頂点（または直前の頂点）からこの px 以内をクリックしたら、閉じる・終える
const CLOSE_PX = 8
const MARK_PX = 4
// 細い通路でもクリックで選べるよう、幅の外にこの px の余裕を持たせる
const HIT_SLACK_PX = 4

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

// 通路の帯（幅を太さにした線）と中心線
function drawAisle(a: Pick<Aisle, 'points' | 'width' | 'closed'>, cls: string): SVGGElement {
  const g = svg('g', { class: cls })
  const d = pathOf(a.points, a.closed)
  g.append(svg('path', { class: 'aisle-body', d, 'stroke-width': a.width }), svg('path', { class: 'aisle-center', d }))
  return g
}

export function mountAisles(canvas: Canvas, editor: Editor): void {
  // 敷地より上、設備より下に描く
  const layer = svg('g', { class: 'aisle-layer' })
  canvas.world.insertBefore(layer, canvas.world.querySelector('.equipment-layer'))
  let selected: string[] = []

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
  box.append(info, drawForm, selInfo, props, row, hint)

  // 敷地の欄の下、ひな形の上に置く
  const templatesHeading = canvas.side.querySelector('h2 + .templates')?.previousElementSibling
  if (templatesHeading) canvas.side.insertBefore(h, templatesHeading)
  else canvas.side.append(h)
  h.after(box)

  const liveSelection = () => selected.filter((id) => editor.scene().aisles.some((a) => a.id === id))
  const select = (ids: string[]) => {
    selected = ids
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
  const updateSelection = (changes: { name?: string; width?: number }) => {
    const ids = (editIds.length ? editIds : liveSelection()).filter((id) => editor.scene().aisles.some((a) => a.id === id))
    if (ids.length) editor.run({ type: 'updateAisle', ids, changes })
  }
  nameInput.addEventListener('change', () => updateSelection({ name: nameInput.value }))
  widthInput.addEventListener('change', () => updateSelection({ width: Number(widthInput.value) }))
  const removeSelection = () => {
    const ids = liveSelection()
    if (ids.length && editor.run({ type: 'removeAisle', ids })) select([])
  }
  delBtn.addEventListener('click', removeSelection)

  // ---- 選ぶ: 設備の無い所のクリックで、通路に当たれば選ぶ ----
  editor.onEmptyClick((at) => {
    const hit = aisleHitTest(editor.scene(), at, HIT_SLACK_PX / canvas.getViewport().scale)
    // 設備と通路は同時に選ばない
    if (hit) editor.select([])
    selected = hit ? [hit] : []
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
    if (e.key === 'Delete' || e.key === 'Backspace') removeSelection()
    else if (e.key === 'Escape') select([])
    else return
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
    layer.replaceChildren(...scene.aisles.map((a) => drawAisle(a, `aisle${sel.has(a.id) ? ' selected' : ''}`)))

    const total = scene.aisles.reduce((s, a) => s + aisleLength(a), 0)
    info.textContent = scene.aisles.length ? `${scene.aisles.length} 本　中心線の計 ${fmtM(total)}` : 'なし'
    const items = scene.aisles.filter((a) => sel.has(a.id))
    props.hidden = items.length !== 1
    row.hidden = items.length === 0
    selInfo.hidden = items.length !== 1
    // 描いた直後の知らせは、通路の選択が外れたら消す
    if (items.length === 0 && hint.textContent?.includes('を描きました')) hint.textContent = ''
    const first = items[0]
    if (first) {
      if (document.activeElement !== nameInput) nameInput.value = first.name
      if (document.activeElement !== widthInput) widthInput.value = String(first.width)
      selInfo.textContent = `選択中: ${first.name}（${first.closed ? '周回、' : ''}頂点 ${first.points.length}、長さ ${fmtM(aisleLength(first))}）`
    }
  }
  editor.onRender(paint)
  paint()
}
