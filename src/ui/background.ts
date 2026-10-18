// 背景の図面: 画像か PDF を読む、2 点の距離か紙の縮尺で縮尺を合わせる、原点を合わせる、外す。
// シーンの変更は editor.run（コマンド）を通す。透明度と表示の入り切りは見え方なので、シーンに入れない。
import type { Canvas } from './canvas'
import type { Editor, Tool } from './editor'
import { backgroundRect, createBackground, paperScaleCalibration, type Background } from '../core/background'
import { formatLength, type Point } from '../core/viewport'
import { renderPdfPage } from './pdf'

const SVG_NS = 'http://www.w3.org/2000/svg'
const SAMPLE_URL = `${import.meta.env.BASE_URL}sample-plan.svg`
// 拾った点の印の大きさ（画面の px）
const MARK_PX = 6

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v))
  return el
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error ?? new Error('読み込めませんでした'))
    r.readAsDataURL(blob)
  })
}

function imageSize(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => reject(new Error('画像として読めませんでした'))
    img.src = src
  })
}

// Shift を押している間は、1 点目から水平か垂直に限る（寸法線を拾いやすくする）
function constrain(a: Point, p: Point, on: boolean): Point {
  if (!on) return p
  return Math.abs(p.x - a.x) >= Math.abs(p.y - a.y) ? { x: p.x, y: a.y } : { x: a.x, y: p.y }
}

const fmtScale = (bg: Background) => `1 px = ${Number(bg.mmPerPixel.toPrecision(4))} mm`

export function mountBackground(canvas: Canvas, editor: Editor): void {
  // ---- 背景の画像を描く ----
  const image = svg('image', { class: 'background', preserveAspectRatio: 'none' })
  canvas.underlay.append(image)
  let drawn: Background | null = null
  let opacity = 0.6
  let visible = true

  // ---- 左の欄 ----
  const h = document.createElement('h2')
  h.textContent = '背景の図面'
  const box = document.createElement('div')
  box.className = 'background-panel'
  const info = document.createElement('div')
  info.className = 'info'
  const row1 = document.createElement('div')
  row1.className = 'actions'
  const row2 = document.createElement('div')
  row2.className = 'actions'
  const mk = (row: HTMLElement, label: string, title: string, onClick: () => void) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = label
    b.title = title
    b.addEventListener('click', onClick)
    row.append(b)
    return b
  }
  const file = document.createElement('input')
  file.type = 'file'
  file.accept = 'image/*,application/pdf,.pdf'
  file.hidden = true
  const loadBtn = mk(row1, '図面を読む', '建物の図面（PDF か、PNG・JPEG・SVG などの画像）を背景に置く。PDF は 1 ページを画像にする', () => file.click())
  mk(row1, 'サンプル', '架空の工場の図面（36 m × 24 m）を背景に置く', () => void loadSample())
  const removeBtn = mk(row1, '外す', '背景の画像を外す（元に戻すで戻せる）', () => {
    editor.run({ type: 'setBackground', background: null })
  })
  const calBtn = mk(row2, '縮尺を合わせる', '図面の上の 2 点をクリックし、その間の長さ（mm）を入れる', () => startCalibrate())
  const originBtn = mk(row2, '原点を合わせる', 'クリックした図面の点を原点 (0, 0) にする', () => startOrigin())

  const view = document.createElement('div')
  view.className = 'bg-view'
  const show = document.createElement('input')
  show.type = 'checkbox'
  show.checked = visible
  show.title = '背景を見せる・隠す（保存しない）'
  show.addEventListener('change', () => {
    visible = show.checked
    paint()
  })
  const range = document.createElement('input')
  range.type = 'range'
  range.min = '0.1'
  range.max = '1'
  range.step = '0.05'
  range.value = String(opacity)
  range.title = '背景の濃さ（保存しない）'
  range.addEventListener('input', () => {
    opacity = Number(range.value)
    paint()
  })
  const showLabel = document.createElement('label')
  showLabel.append(show, '表示')
  const rangeLabel = document.createElement('label')
  rangeLabel.append('濃さ ', range)
  view.append(showLabel, rangeLabel)

  // 縮尺合わせの 2 点目を拾った後に、長さを入れる欄
  const ask = document.createElement('form')
  ask.className = 'calibrate-form'
  ask.hidden = true
  const distance = document.createElement('input')
  distance.type = 'number'
  distance.min = '1'
  distance.step = '1'
  distance.title = '2 点の間の本当の長さ（mm）'
  const apply = document.createElement('button')
  apply.type = 'submit'
  apply.textContent = '合わせる'
  ask.append('長さ ', distance, ' mm ', apply)
  const hint = document.createElement('div')
  hint.className = 'hint'

  // PDF を読んだ直後に出す欄: 紙の縮尺で合わせる、別のページを読む
  const pdfForm = document.createElement('form')
  pdfForm.className = 'pdf-form'
  pdfForm.hidden = true
  const denom = document.createElement('input')
  denom.type = 'number'
  denom.min = '1'
  denom.step = '1'
  denom.placeholder = '100'
  denom.title = '図面に書いてある縮尺（1/400 なら 400）。スキャンや印刷で数 % ずれることがあるので、寸法線で確かめる'
  const denomBtn = document.createElement('button')
  denomBtn.type = 'submit'
  denomBtn.textContent = '合わせる'
  const pageBox = document.createElement('span')
  const pageNo = document.createElement('input')
  pageNo.type = 'number'
  pageNo.min = '1'
  pageNo.step = '1'
  pageNo.title = '背景にするページ'
  const pageBtn = document.createElement('button')
  pageBtn.type = 'button'
  pageBtn.textContent = '読む'
  const pageCount = document.createElement('span')
  pageBox.append(' ページ ', pageNo, pageCount, ' ', pageBtn)
  pdfForm.append('紙の縮尺 1/', denom, ' ', denomBtn, pageBox)

  canvas.side.prepend(h, box)
  box.append(info, row1, row2, view, ask, pdfForm, hint, file)

  // ---- 読み込み ----
  // 今の背景が読んだ PDF のページなら、その PDF（別のページを読む・紙の縮尺で合わせるのに使う）
  let pdf: { data: ArrayBuffer; name: string; dpi: number; page: number; pages: number; background: Background } | null = null
  const isPdf = (blob: Blob, name: string) => blob.type === 'application/pdf' || /\.pdf$/i.test(name)
  const placePdf = async (data: ArrayBuffer, name: string, page: number) => {
    hint.textContent = 'PDF を画像にしています…'
    const r = await renderPdfPage(data, page)
    const label = r.pages > 1 ? `${name}（${r.page} / ${r.pages} ページ）` : name
    const background = createBackground(r.src, label, r.width, r.height)
    if (!editor.run({ type: 'setBackground', background })) return
    pdf = { data, name, dpi: r.dpi, page: r.page, pages: r.pages, background }
    pageNo.value = String(r.page)
    pageNo.max = String(r.pages)
    pageCount.textContent = ` / ${r.pages}`
    hint.textContent = `PDF の ${r.page} ページ目を ${Math.round(r.dpi)} dpi の画像にして、仮の縮尺（幅 20 m）で置きました。図面の縮尺（1/100 なら 100）を入れて「合わせる」か、「縮尺を合わせる」で寸法の分かる 2 点を選んでください`
    fit()
    paint()
  }
  const place = async (blob: Blob, name: string) => {
    try {
      if (isPdf(blob, name)) {
        await placePdf(await blob.arrayBuffer(), name, 1)
        return
      }
      const src = await readAsDataUrl(blob)
      const size = await imageSize(src)
      if (!(size.width > 0 && size.height > 0)) throw new Error('画像の大きさが分かりません（SVG なら width と height を付けてください）')
      if (editor.run({ type: 'setBackground', background: createBackground(src, name, size.width, size.height) })) {
        hint.textContent = '仮の縮尺（幅 20 m）で置きました。「縮尺を合わせる」で 2 点を選んでください'
        fit()
      }
    } catch (err) {
      hint.textContent = err instanceof Error ? err.message : String(err)
    }
  }
  file.addEventListener('change', () => {
    const f = file.files?.[0]
    file.value = ''
    if (f) void place(f, f.name)
  })
  const loadSample = async () => {
    try {
      const res = await fetch(SAMPLE_URL)
      if (!res.ok) throw new Error(`サンプルを読めませんでした（${res.status}）`)
      await place(await res.blob(), 'sample-plan.svg')
    } catch (err) {
      hint.textContent = err instanceof Error ? err.message : String(err)
    }
  }
  const fit = () => {
    canvas.fitHome()
  }
  pdfForm.addEventListener('submit', (e) => {
    e.preventDefault()
    const bg = editor.scene().background
    if (!pdf || !bg) return
    const c = paperScaleCalibration(bg, pdf.dpi, Number(denom.value))
    if (!c) {
      hint.textContent = '縮尺は正の数で入れてください（1/400 なら 400）'
      denom.focus()
      return
    }
    if (editor.run({ type: 'calibrateBackground', ...c })) {
      const now = editor.scene().background
      hint.textContent = now
        ? `紙の縮尺 1/${denom.value} で合わせました（${fmtScale(now)}）。スキャンや印刷で数 % ずれることがあるので、寸法線を「縮尺を合わせる」で確かめると確実です`
        : ''
      fit()
    }
  })
  pageBtn.addEventListener('click', () => {
    if (!pdf) return
    const n = Number(pageNo.value)
    void placePdf(pdf.data, pdf.name, n).catch((err: unknown) => {
      hint.textContent = err instanceof Error ? err.message : String(err)
    })
  })

  // ---- 縮尺合わせの道具 ----
  let cal: { a: Point | null; b: Point | null; shift: boolean } = { a: null, b: null, shift: false }
  const mark = (p: Point, scale: number) => {
    const r = MARK_PX / scale
    return svg('path', { class: 'pick-mark', d: `M${p.x - r} ${p.y}H${p.x + r}M${p.x} ${p.y - r}V${p.y + r}` })
  }
  const calibrateTool: Tool = {
    pointerDown(at, e) {
      if (!cal.a || cal.b) {
        cal = { a: at, b: null, shift: false }
        ask.hidden = true
        hint.textContent = '2 点目をクリック（Shift で水平・垂直）。Esc でやめる'
        return
      }
      const a = cal.a
      const b = constrain(a, at, e.shiftKey)
      if (b.x === a.x && b.y === a.y) return
      cal = { ...cal, b }
      const now = Math.hypot(b.x - a.x, b.y - a.y)
      distance.value = String(Math.round(now))
      ask.hidden = false
      hint.textContent = `今の長さは ${formatLength(Math.round(now))}。本当の長さ（mm）を入れて「合わせる」。別の 2 点を選び直すならクリック`
      distance.focus()
      distance.select()
    },
    overlay(pointer) {
      const scale = canvas.getViewport().scale
      const out: SVGElement[] = []
      const a = cal.a
      if (!a) return out
      const b = cal.b ?? (pointer ? constrain(a, pointer, cal.shift) : null)
      if (b) out.push(svg('line', { class: 'pick-line', x1: a.x, y1: a.y, x2: b.x, y2: b.y }))
      out.push(mark(a, scale))
      if (cal.b) out.push(mark(cal.b, scale))
      return out
    },
    ended() {
      cal = { a: null, b: null, shift: false }
      ask.hidden = true
      calBtn.classList.remove('active')
      hint.textContent = ''
    },
  }
  // Shift の押し下げを線の見た目に反映する
  const trackShift = (e: KeyboardEvent) => {
    if (e.key !== 'Shift' || !cal.a || cal.b) return
    cal = { ...cal, shift: e.type === 'keydown' }
    editor.render()
  }
  window.addEventListener('keydown', trackShift)
  window.addEventListener('keyup', trackShift)
  canvas.svg.addEventListener('pointermove', (e) => {
    if (cal.a && !cal.b) cal = { ...cal, shift: e.shiftKey }
  })

  const startCalibrate = () => {
    if (!editor.scene().background) return
    editor.startTool(calibrateTool)
    calBtn.classList.add('active')
    hint.textContent = '1 点目をクリック（寸法の分かる 2 点を選ぶ。拡大すると正確に拾える）。Esc でやめる'
  }
  ask.addEventListener('submit', (e) => {
    e.preventDefault()
    const { a, b } = cal
    if (!a || !b) return
    const d = Number(distance.value)
    if (editor.run({ type: 'calibrateBackground', a, b, distance: d })) {
      editor.endTool(calibrateTool)
      const bg = editor.scene().background
      hint.textContent = bg ? `縮尺を合わせました（${fmtScale(bg)}）` : ''
      fit()
    } else {
      distance.focus()
    }
  })

  // ---- 原点合わせの道具 ----
  const originTool: Tool = {
    pointerDown(at) {
      if (editor.run({ type: 'moveBackground', dx: -at.x, dy: -at.y })) {
        editor.endTool(originTool)
        hint.textContent = 'クリックした点を原点にしました'
        fit()
      }
    },
    overlay: (pointer) => (pointer ? [mark(pointer, canvas.getViewport().scale)] : []),
    ended() {
      originBtn.classList.remove('active')
      if (hint.textContent?.startsWith('原点にする')) hint.textContent = ''
    },
  }
  const startOrigin = () => {
    if (!editor.scene().background) return
    editor.startTool(originTool)
    originBtn.classList.add('active')
    hint.textContent = '原点にする図面の点をクリック（建物の角など）。Esc でやめる'
  }

  // ---- シーンに合わせて描き直す ----
  function paint() {
    const bg = editor.scene().background
    if (bg !== drawn) {
      drawn = bg
      if (bg) {
        const r = backgroundRect(bg)
        image.setAttribute('href', bg.src)
        image.setAttribute('x', String(r.x))
        image.setAttribute('y', String(r.y))
        image.setAttribute('width', String(r.width))
        image.setAttribute('height', String(r.height))
      } else {
        image.removeAttribute('href')
      }
    }
    image.style.display = bg && visible ? '' : 'none'
    image.style.opacity = String(opacity)
    if (bg) {
      const r = backgroundRect(bg)
      info.textContent =
        `${bg.name}　${formatLength(Math.round(r.width))} × ${formatLength(Math.round(r.height))}　` +
        `${fmtScale(bg)}${bg.calibrated ? '' : '（仮の縮尺）'}`
    } else {
      info.textContent = 'なし'
    }
    info.classList.toggle('warn', !!bg && !bg.calibrated)
    // 背景が読んだ PDF のページでなくなったら（外す・別の画像）、PDF の欄をしまう。縮尺や位置を変えても画像は同じなので残す
    if (pdf && bg?.src !== pdf.background.src) pdf = null
    pdfForm.hidden = !pdf
    pageBox.hidden = !pdf || pdf.pages < 2
    for (const b of [removeBtn, calBtn, originBtn]) b.disabled = !bg
    for (const el of [show, range]) el.disabled = !bg
    loadBtn.disabled = false
  }
  editor.onRender(paint)
  paint()
}
