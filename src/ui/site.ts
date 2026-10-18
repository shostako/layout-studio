// 敷地の外形: クリックで多角形を描く、寸法で長方形を置く、辺の向きと長さで描く、頂点を数値で直す、消す。面積とはみ出しの台数を出す。
// シーンの変更は editor.run（コマンド）を通す。描いている途中の頂点は画面の状態で、閉じたときに 1 回だけ setSite を出す。
import type { Canvas } from './canvas'
import type { Editor, Tool } from './editor'
import { snapValue } from '../core/placement'
import { equipmentOutsideSite, moveSiteVertex, parseSiteSteps, rectSite, siteArea, siteBounds, siteFromSteps, siteToSteps, type Site } from '../core/site'
import { formatLength, type Point } from '../core/viewport'

const SVG_NS = 'http://www.w3.org/2000/svg'
// 最初の頂点（または直前の頂点）からこの px 以内をクリックしたら閉じる
const CLOSE_PX = 8
const MARK_PX = 4
// 1 坪 = 400/121 m²
const M2_PER_TSUBO = 400 / 121

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

const fmtArea = (mm2: number) => {
  const m2 = mm2 / 1e6
  return `${m2.toLocaleString('ja-JP', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} m²（${(m2 / M2_PER_TSUBO).toLocaleString('ja-JP', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} 坪）`
}
const pathOf = (pts: readonly Point[], close: boolean) =>
  pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join('') + (close && pts.length > 2 ? 'Z' : '')

export function mountSite(canvas: Canvas, editor: Editor): void {
  // ---- 外形を描く（設備より下） ----
  const outline = svg('path', { class: 'site' })
  canvas.world.prepend(outline)
  let drawn: Site | null | undefined

  // ---- 左の欄 ----
  const h = document.createElement('h2')
  h.textContent = '敷地'
  const box = document.createElement('div')
  box.className = 'site-panel'
  const info = document.createElement('div')
  info.className = 'info'
  const row = document.createElement('div')
  row.className = 'actions'
  const mk = (label: string, title: string, onClick: () => void) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = label
    b.title = title
    b.addEventListener('click', onClick)
    row.append(b)
    return b
  }
  const drawBtn = mk('外形を描く', 'クリックで頂点を置き、最初の頂点のクリックか Enter で閉じる', () => startDraw())
  const clearBtn = mk('消す', '敷地の外形を消す（元に戻すで戻せる）', () => editor.run({ type: 'setSite', site: null }))

  // 寸法を入れて、原点を左上にした長方形を置く
  const rectForm = document.createElement('form')
  rectForm.className = 'site-rect-form'
  // 矢印キーは 100 mm 刻みにしたいが、刻みに乗らない寸法も受け付ける（確かめは submit で自分でする）
  rectForm.noValidate = true
  const mkNum = (value: number, title: string) => {
    const input = document.createElement('input')
    input.type = 'number'
    input.min = '1'
    input.step = '100'
    input.value = String(value)
    input.title = title
    return input
  }
  const rw = mkNum(30000, '敷地の幅（x 方向、mm）')
  const rd = mkNum(20000, '敷地の奥行（y 方向、mm）')
  const rectBtn = document.createElement('button')
  rectBtn.type = 'submit'
  rectBtn.textContent = '長方形'
  rectBtn.title = '原点 (0, 0) を左上に、この寸法の長方形を敷地にする'
  rectForm.append(rw, '×', rd, ' mm ', rectBtn)
  // 辺の向きと長さを順に入れて描く（L 字など、長方形でない建物の外形）
  const stepsBox = document.createElement('details')
  stepsBox.className = 'site-steps'
  const stepsSummary = document.createElement('summary')
  stepsSummary.textContent = '寸法で描く'
  stepsSummary.title = '始点と、辺の向き・長さの列で外形を描く（図面の寸法線の値をそのまま入れる）'
  const stepsForm = document.createElement('form')
  stepsForm.noValidate = true
  const sx = mkNum(0, '始点の x（mm）。背景の「原点を合わせる」で建物の角を原点にしておくと 0, 0 で描ける')
  const sy = mkNum(0, '始点の y（mm）')
  for (const el of [sx, sy]) el.removeAttribute('min')
  const stepsText = document.createElement('textarea')
  stepsText.rows = 3
  stepsText.placeholder = '右 35500 下 45700 左 20000 …'
  stepsText.title =
    '向き（右・左・上・下。R・L・U・D も可）と長さ（mm。35.5m とも書ける）を順に並べる。最後の頂点から始点へは自動で閉じる'
  const stepsBtn = document.createElement('button')
  stepsBtn.type = 'submit'
  stepsBtn.textContent = '描く'
  const fromSiteBtn = document.createElement('button')
  fromSiteBtn.type = 'button'
  fromSiteBtn.textContent = '今の外形を入れる'
  fromSiteBtn.title = '今の敷地の外形の始点と辺を欄に入れる（水平・垂直の辺だけの外形）'
  const startRow = document.createElement('div')
  startRow.className = 'site-rect-form'
  startRow.append('始点', sx, ',', sy, 'mm')
  const stepsActions = document.createElement('div')
  stepsActions.className = 'actions'
  stepsActions.append(stepsBtn, fromSiteBtn)
  stepsForm.append(startRow, stepsText, stepsActions)
  stepsBox.append(stepsSummary, stepsForm)

  // 頂点を数値で直す
  const vertBox = document.createElement('details')
  vertBox.className = 'site-vertices'
  const vertSummary = document.createElement('summary')
  vertSummary.textContent = '頂点を数値で直す'
  const vertList = document.createElement('div')
  vertList.className = 'site-vertex-list'
  vertBox.append(vertSummary, vertList)

  const hint = document.createElement('div')
  hint.className = 'hint'
  box.append(info, row, rectForm, stepsBox, vertBox, hint)

  // 背景の欄の下、ひな形の上に置く
  const templatesHeading = canvas.side.querySelector('h2 + .templates')?.previousElementSibling
  if (templatesHeading) canvas.side.insertBefore(h, templatesHeading)
  else canvas.side.append(h)
  h.after(box)

  const fit = () => {
    canvas.fitHome()
  }
  rectForm.addEventListener('submit', (e) => {
    e.preventDefault()
    const w = Number(rw.value)
    const d = Number(rd.value)
    if (!(w > 0 && d > 0 && Number.isFinite(w) && Number.isFinite(d))) {
      hint.textContent = '幅と奥行は正の数（mm）にしてください'
      return
    }
    if (editor.run({ type: 'setSite', site: rectSite(0, 0, w, d) })) {
      hint.textContent = ''
      fit()
    }
  })

  stepsForm.addEventListener('submit', (e) => {
    e.preventDefault()
    const x = Number(sx.value)
    const y = Number(sy.value)
    if (!(Number.isFinite(x) && Number.isFinite(y))) {
      hint.textContent = '始点は数（mm）で入れてください'
      return
    }
    const p = parseSiteSteps(stepsText.value)
    if (!p.ok) {
      hint.textContent = p.error
      return
    }
    const r = siteFromSteps({ x, y }, p.steps)
    if (!r.ok) {
      hint.textContent = r.error
      return
    }
    if (editor.run({ type: 'setSite', site: r.site })) {
      hint.textContent = `外形を描きました（頂点 ${r.site.points.length}、面積 ${fmtArea(siteArea(r.site))}）`
      fit()
    }
  })
  const fillFromSite = () => {
    const site = editor.scene().site
    if (!site) return
    const text = siteToSteps(site)
    if (text === null) {
      hint.textContent = '斜めの辺がある外形は寸法の欄に入れられません。「頂点を数値で直す」で直してください'
      return
    }
    sx.value = String(site.points[0]!.x)
    sy.value = String(site.points[0]!.y)
    stepsText.value = text
    hint.textContent = ''
  }
  fromSiteBtn.addEventListener('click', fillFromSite)
  // 開いたときに欄が空なら、今の外形を入れておく（直すところから始められる）
  stepsBox.addEventListener('toggle', () => {
    if (stepsBox.open && stepsText.value.trim() === '' && editor.scene().site) fillFromSite()
  })

  // 頂点の欄: 外形が変わったら作り直す。入れている途中（欄にフォーカス）は作り直さない
  let listed: Site | null | undefined
  const listVertices = (site: Site | null) => {
    if (site === listed) return
    if (vertList.contains(document.activeElement)) return
    listed = site
    vertList.replaceChildren()
    if (!site) {
      vertList.textContent = '外形がありません'
      return
    }
    for (const [i, p] of site.points.entries()) {
      const r = document.createElement('div')
      r.className = 'site-rect-form'
      const vx = mkNum(p.x, `頂点 ${i + 1} の x（mm）`)
      const vy = mkNum(p.y, `頂点 ${i + 1} の y（mm）`)
      for (const el of [vx, vy]) el.removeAttribute('min')
      const commit = () => {
        const cur = editor.scene().site
        const x = Number(vx.value)
        const y = Number(vy.value)
        if (!cur || !cur.points[i] || !(Number.isFinite(x) && Number.isFinite(y))) return
        if (x === cur.points[i]!.x && y === cur.points[i]!.y) return
        if (editor.run({ type: 'setSite', site: moveSiteVertex(cur, i, { x, y }) })) hint.textContent = `頂点 ${i + 1} を動かしました`
        else {
          // 辺が交わるなど。理由は editor の欄に出る。欄を今の値に戻す
          vx.value = String(cur.points[i]!.x)
          vy.value = String(cur.points[i]!.y)
        }
      }
      for (const el of [vx, vy])
        el.addEventListener('change', () => {
          commit()
          // 入れ終わったら、ほかの頂点の値も合わせて作り直す
          listed = undefined
          queueMicrotask(() => listVertices(editor.scene().site))
        })
      r.append(`${i + 1}`, vx, ',', vy)
      vertList.append(r)
    }
  }

  // ---- 外形を描く道具 ----
  let pts: Point[] = []
  let shift = false
  const scale = () => canvas.getViewport().scale
  // カーソルの位置を、スナップと Shift を当てた頂点の候補にする
  const candidate = (at: Point, shiftKey: boolean): Point => {
    const step = editor.snapStep()
    return constrain(pts[pts.length - 1], { x: snapValue(at.x, step), y: snapValue(at.y, step) }, shiftKey)
  }
  const near = (a: Point | undefined, b: Point) => !!a && Math.hypot(a.x - b.x, a.y - b.y) * scale() <= CLOSE_PX
  const showProgress = () => {
    const area = pts.length >= 3 ? `　面積 ${fmtArea(siteArea({ points: pts }))}` : ''
    hint.textContent =
      `頂点 ${pts.length}${area}。` +
      (pts.length >= 3 ? '最初の頂点をクリックか Enter で閉じる。' : 'クリックで頂点を置く。') +
      'Shift で水平・垂直、Backspace で 1 つ戻す、Esc でやめる'
  }
  const finish = () => {
    if (pts.length < 3) return
    if (editor.run({ type: 'setSite', site: { points: pts } })) {
      const done = pts
      editor.endTool(drawTool)
      hint.textContent = `外形を描きました（頂点 ${done.length}）`
      fit()
    } else {
      // 辺が交わっているなど。理由は editor の欄に出る。Backspace で直せるよう描き続ける
      hint.textContent = '閉じられませんでした（理由は下の欄）。Backspace で頂点を戻して直してください'
    }
  }
  const drawTool: Tool = {
    pointerDown(at, e) {
      const p = candidate(at, e.shiftKey)
      if (pts.length >= 3 && near(pts[0], p)) return finish()
      // ダブルクリックの 2 回目（直前の頂点と同じ所）も閉じる合図にする
      if (near(pts[pts.length - 1], p)) {
        if (pts.length >= 3) finish()
        return
      }
      pts = [...pts, p]
      showProgress()
    },
    overlay(pointer) {
      const out: SVGElement[] = []
      if (pts.length === 0) {
        if (pointer) {
          const p = candidate(pointer, false)
          const r = MARK_PX / scale()
          out.push(svg('path', { class: 'pick-mark', d: `M${p.x - r} ${p.y}H${p.x + r}M${p.x} ${p.y - r}V${p.y + r}` }))
        }
        return out
      }
      const next = pointer ? candidate(pointer, shift) : null
      const closing = !!next && pts.length >= 3 && near(pts[0], next)
      const live = next && !closing ? [...pts, next] : pts
      out.push(svg('path', { class: 'site drawing', d: pathOf(live, true) }))
      const r = MARK_PX / scale()
      for (const [i, p] of pts.entries())
        out.push(svg('circle', { class: i === 0 && closing ? 'site-vertex closing' : 'site-vertex', cx: p.x, cy: p.y, r: i === 0 && closing ? r * 2 : r }))
      return out
    },
    ended() {
      pts = []
      shift = false
      drawBtn.classList.remove('active')
      if (hint.textContent?.startsWith('頂点') || hint.textContent?.startsWith('閉じられ')) hint.textContent = ''
    },
  }
  const startDraw = () => {
    editor.startTool(drawTool)
    drawBtn.classList.add('active')
    pts = []
    hint.textContent = 'クリックで頂点を置く（スナップの間隔に乗る）。Esc でやめる'
  }
  const drawing = () => drawBtn.classList.contains('active')
  window.addEventListener('keydown', (e) => {
    if (!drawing()) return
    if (e.key === 'Shift') {
      shift = true
      editor.render()
      return
    }
    const t = e.target
    if (t instanceof HTMLElement && t.closest('input, select, textarea')) return
    if (e.key === 'Enter') finish()
    else if (e.key === 'Backspace' || e.key === 'Delete') {
      pts = pts.slice(0, -1)
      showProgress()
      editor.render()
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
    const site = scene.site
    if (site !== drawn) {
      drawn = site
      outline.setAttribute('d', site ? pathOf(site.points, true) : '')
    }
    outline.style.display = site ? '' : 'none'
    if (site) {
      const b = siteBounds(site)
      const out = equipmentOutsideSite(scene)
      info.textContent =
        `面積 ${fmtArea(siteArea(site))}　外寸 ${formatLength(Math.round(b.width))} × ${formatLength(Math.round(b.height))}` +
        (out.length ? `　はみ出し ${out.length} 台` : '')
      info.classList.toggle('warn', out.length > 0)
    } else {
      info.textContent = 'なし'
      info.classList.remove('warn')
    }
    clearBtn.disabled = !site
    fromSiteBtn.disabled = !site
    listVertices(site)
  }
  editor.onRender(paint)
  paint()
}
