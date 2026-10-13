// 道具バーの「画像」: 開いている案の図面を PNG に書き出す。
// 写す範囲と大きさは src/core/imageExport.ts。画面に描いている図面（背景・敷地・通路・設備・つなぎ・注意の色）を写し、
// 選択の印・道具の線・通路の頂点のつまみは外す。色は画面の見え方に関わらずライトにする（資料に貼るため）。
// 画面を白黒にしていれば、画像も白黒にする。
import { exportFrame, imageFileName, scaleBarLength } from '../core/imageExport'
import { activePlan } from '../core/plans'
import { formatLength } from '../core/viewport'
import type { Canvas } from './canvas'
import type { Editor } from './editor'
import type { Plans } from './plans'

const SVG_NS = 'http://www.w3.org/2000/svg'

// 画像に入れない層と印
const DROP = '.tool-layer, .aisle-handle-layer, .link-from, .ghost'

// 画面の CSS のうち、通常の規則だけを写す（ダークの切り替えと狭い画面の規則は入れない。色はライトの変数のまま）
function lightCss(): string {
  const out: string[] = []
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList
    try {
      rules = sheet.cssRules
    } catch {
      continue
    }
    for (const r of Array.from(rules)) {
      if (r instanceof CSSStyleRule && !r.selectorText.includes('data-theme')) out.push(r.cssText)
    }
  }
  return out.join('\n')
}

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v))
  return e
}

// 書き出す SVG（文字列）。frame の範囲を、frame の px の大きさで写す
function buildSvg(canvas: Canvas, frame: NonNullable<ReturnType<typeof exportFrame>>, title: string): string {
  const { view, width, height } = frame
  const root = el('svg', { xmlns: SVG_NS, width, height, viewBox: `${view.x} ${view.y} ${view.width} ${view.height}` })
  // 画面が白黒なら、画像も白黒にする（style.css の .mono の規則が効く）
  if (canvas.svg.closest('.canvas-root')?.classList.contains('mono')) root.setAttribute('class', 'mono')
  const style = el('style', {})
  style.textContent = `${lightCss()}\nsvg{background:#fafaf8;font-family:system-ui,'Hiragino Sans','Yu Gothic UI','Meiryo',sans-serif}`
  root.append(style, el('rect', { x: view.x, y: view.y, width: view.width, height: view.height, fill: '#fafaf8' }))
  for (const layer of [canvas.underlay, canvas.world]) {
    const g = layer.cloneNode(true) as SVGGElement
    g.removeAttribute('transform')
    for (const d of Array.from(g.querySelectorAll(DROP))) d.remove()
    for (const s of Array.from(g.querySelectorAll('.selected'))) s.classList.remove('selected')
    root.append(g)
  }
  // 左下に案の名前と縮尺の目盛り
  const unit = view.width / frame.width // 1 px が何 mm か
  const bar = scaleBarLength(view.width)
  const x0 = view.x + 24 * unit
  const y0 = view.y + view.height - 24 * unit
  const font = 22 * unit
  const caption = el('text', { x: x0, y: y0 - 16 * unit, 'font-size': font, fill: '#222' })
  caption.textContent = title
  root.append(
    caption,
    el('rect', { x: x0, y: y0 - 6 * unit, width: bar, height: 6 * unit, fill: '#222' }),
    Object.assign(el('text', { x: x0 + bar + 8 * unit, y: y0, 'font-size': font * 0.8, fill: '#222' }), {
      textContent: formatLength(bar),
    }),
  )
  return new XMLSerializer().serializeToString(root)
}

async function toPng(svgText: string, width: number, height: number): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml' }))
  try {
    const img = new Image()
    img.decoding = 'async'
    await new Promise<void>((ok, ng) => {
      img.onload = () => ok()
      img.onerror = () => ng(new Error('図面を画像にできませんでした'))
      img.src = url
    })
    const c = document.createElement('canvas')
    c.width = width
    c.height = height
    const ctx = c.getContext('2d')
    if (!ctx) throw new Error('このブラウザでは画像を作れません')
    ctx.drawImage(img, 0, 0, width, height)
    return await new Promise<Blob>((ok, ng) => c.toBlob((b) => (b ? ok(b) : ng(new Error('PNG にできませんでした'))), 'image/png'))
  } finally {
    URL.revokeObjectURL(url)
  }
}

export function mountExportImage(canvas: Canvas, editor: Editor, plans: Plans): void {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'export-image'
  b.textContent = '画像'
  b.title = '開いている案の図面を PNG 画像で保存する（資料に貼る用。色はライト、左下に案の名前と縮尺）'
  const note = document.createElement('span')
  note.className = 'save-state'
  b.addEventListener('click', async () => {
    b.blur()
    // 背景を隠しているとき（背景の欄の「表示」を外したとき）は、背景を写さず範囲にも入れない
    const bgShown = Array.from(canvas.underlay.querySelectorAll('image')).some((i) => i.style.display !== 'none')
    const frame = exportFrame(editor.scene(), undefined, bgShown)
    if (!frame) {
      note.textContent = '図面に何もありません'
      return
    }
    b.disabled = true
    note.textContent = '画像を作っています…'
    try {
      // 再生中の重ねや選択の描き直しを待たず、今の画面の描画をそのまま写す
      const name = activePlan(plans.current()).name
      const png = await toPng(buildSvg(canvas, frame, name), frame.width, frame.height)
      const url = URL.createObjectURL(png)
      const a = document.createElement('a')
      a.href = url
      a.download = imageFileName(new Date())
      // 文書に入れてから押す（入れないと名前が付かないブラウザがある）
      document.body.append(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      note.textContent = `画像を保存した（${frame.width} × ${frame.height} px）`
    } catch (e) {
      note.textContent = e instanceof Error ? e.message : String(e)
    } finally {
      b.disabled = false
    }
  })
  // 「保存」の隣に置く
  const save = Array.from(canvas.toolbar.querySelectorAll('button')).find((x) => x.textContent === '保存')
  if (save) save.after(b)
  else canvas.toolbar.prepend(b)
  b.after(note)
}
