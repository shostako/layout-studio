// 図面のキャンバス。SVG にグリッドを描き、拡大縮小と移動を受ける。
// 表示範囲の計算は src/core/viewport.ts の純関数に任せ、ここでは結果を受け取って描くだけにする。
import {
  fitRect,
  formatLength,
  gridLines,
  gridStep,
  panBy,
  screenToWorld,
  worldToScreen,
  zoomAt,
  type Point,
  type Rect,
  type Size,
  type Viewport,
} from '../core/viewport'

const SVG_NS = 'http://www.w3.org/2000/svg'

// 最初に見せる範囲（架空の 20 m × 15 m）。背景の図面が入ったら setHome でそちらに合わせる
const DEFAULT_HOME: Rect = { x: 0, y: 0, width: 20000, height: 15000 }

// ホイール 1 目盛り（deltaY = 100）で 1.2 倍
const WHEEL_ZOOM_PER_100 = 1.2
const BUTTON_ZOOM = 1.5

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string> = {}): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  return el
}

export type Canvas = {
  svg: SVGSVGElement
  // 図面の座標（mm）で描くものを入れる層。設備はここに足す
  world: SVGGElement
  // world と同じ座標で、グリッドより下に描く層（背景の図面）
  underlay: SVGGElement
  toolbar: HTMLElement
  // キャンバスの左に置く欄（ひな形など）
  side: HTMLElement
  getViewport(): Viewport
  // 画面の座標（clientX, clientY）を図面の座標（mm）にする
  toWorld(clientX: number, clientY: number): Point
  // Space を押している間の左ボタンは画面の移動に使う
  isPanKeyDown(): boolean
  // 「全体」で見せる範囲を変える（null で最初の範囲に戻す）。表示はまだ動かさない
  setHome(rect: Rect | null): void
  // 「全体」の範囲を画面に収める
  fitHome(): void
}

export function mountCanvas(root: HTMLElement): Canvas {
  root.classList.add('canvas-root')

  const toolbar = document.createElement('div')
  toolbar.className = 'toolbar'
  const mkButton = (label: string, title: string, onClick: () => void) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = label
    b.title = title
    b.addEventListener('click', onClick)
    toolbar.append(b)
  }

  const svgEl = svg('svg', { class: 'canvas' })
  const gridMinor = svg('path', { class: 'grid-minor' })
  const gridMajor = svg('path', { class: 'grid-major' })
  const axes = svg('path', { class: 'axes' })
  const world = svg('g', { class: 'world' })
  const underlay = svg('g', { class: 'underlay' })
  svgEl.append(underlay, gridMinor, gridMajor, axes, world)

  const status = document.createElement('div')
  status.className = 'status'

  const side = document.createElement('div')
  side.className = 'side'

  root.append(toolbar, side, svgEl, status)

  const size = (): Size => {
    const r = svgEl.getBoundingClientRect()
    return { width: Math.max(1, r.width), height: Math.max(1, r.height) }
  }

  let homeRect: Rect = DEFAULT_HOME
  let view: Viewport = fitRect(homeRect, size())
  // 使う人が一度も動かしていない間は、窓の大きさが決まるたびに最初の範囲へ合わせ直す
  let touched = false
  let cursor: Point | null = null
  let frame = 0

  const redraw = () => {
    if (!frame) frame = requestAnimationFrame(draw)
  }
  const setView = (next: Viewport) => {
    touched = true
    view = next
    redraw()
  }

  function draw() {
    frame = 0
    const s = size()
    const step = gridStep(view.scale)
    const lines = gridLines(view, s, step)
    // 画面の座標で 1 px の線をくっきり引くため、整数に丸めて 0.5 px ずらす
    const sx = (x: number) => Math.round((x - view.originX) * view.scale) + 0.5
    const sy = (y: number) => Math.round((y - view.originY) * view.scale) + 0.5
    const path = (xs: number[], ys: number[]) =>
      xs.map((x) => `M${sx(x)} 0V${s.height}`).join('') + ys.map((y) => `M0 ${sy(y)}H${s.width}`).join('')
    gridMinor.setAttribute('d', path(lines.xs, lines.ys))
    gridMajor.setAttribute('d', path(lines.majorXs, lines.majorYs))
    const o = worldToScreen(view, { x: 0, y: 0 })
    axes.setAttribute('d', `M${Math.round(o.x) + 0.5} 0V${s.height}M0 ${Math.round(o.y) + 0.5}H${s.width}`)
    const m = `matrix(${view.scale} 0 0 ${view.scale} ${-view.originX * view.scale} ${-view.originY * view.scale})`
    world.setAttribute('transform', m)
    underlay.setAttribute('transform', m)
    const pos = cursor ? `x ${Math.round(cursor.x)} mm, y ${Math.round(cursor.y)} mm` : '—'
    status.textContent =
      `${pos}　｜　グリッド ${formatLength(step.minor)}（太線 ${formatLength(step.major)}）` +
      `　｜　1 m = ${Number((view.scale * 1000).toPrecision(3))} px`
  }

  const center = (): Point => {
    const s = size()
    return { x: s.width / 2, y: s.height / 2 }
  }
  const zoomIn = () => setView(zoomAt(view, center(), BUTTON_ZOOM))
  const zoomOut = () => setView(zoomAt(view, center(), 1 / BUTTON_ZOOM))
  const home = () => setView(fitRect(homeRect, size()))

  mkButton('＋', '拡大（+ キー）', zoomIn)
  mkButton('－', '縮小（- キー）', zoomOut)
  mkButton('全体', '図面の全体を表示（0 キー）', home)
  const help = document.createElement('span')
  help.className = 'help'
  help.textContent = 'ホイール: 拡大縮小　中・右ボタンか Space＋左ボタンのドラッグ: 画面の移動'
  toolbar.append(help)

  const local = (e: MouseEvent): Point => {
    const r = svgEl.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  svgEl.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault()
      // deltaMode 1 は行単位（Firefox）で 1 行 ≒ 33 px、2 はページ単位でキャンバスの高さとして換算する
      const dy =
        e.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? e.deltaY * 33
          : e.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? e.deltaY * size().height
            : e.deltaY
      const at = local(e)
      setView(zoomAt(view, at, WHEEL_ZOOM_PER_100 ** (-dy / 100)))
      cursor = screenToWorld(view, at)
    },
    { passive: false },
  )

  let spaceDown = false
  let drag: { id: number; x: number; y: number } | null = null

  svgEl.addEventListener('pointerdown', (e) => {
    const pan = e.button === 1 || e.button === 2 || (e.button === 0 && spaceDown)
    if (!pan) return
    e.preventDefault()
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY }
    svgEl.setPointerCapture(e.pointerId)
    svgEl.classList.add('panning')
  })
  svgEl.addEventListener('pointermove', (e) => {
    if (drag && e.pointerId === drag.id) {
      const dx = e.clientX - drag.x
      const dy = e.clientY - drag.y
      drag.x = e.clientX
      drag.y = e.clientY
      setView(panBy(view, dx, dy))
    }
    cursor = screenToWorld(view, local(e))
    redraw()
  })
  const endDrag = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return
    drag = null
    svgEl.classList.remove('panning')
  }
  svgEl.addEventListener('pointerup', endDrag)
  svgEl.addEventListener('pointercancel', endDrag)
  svgEl.addEventListener('pointerleave', () => {
    cursor = null
    redraw()
  })
  svgEl.addEventListener('contextmenu', (e) => e.preventDefault())

  // ボタンや入力欄がキーを使うときは、キャンバスの操作にしない
  const isInteractive = (t: EventTarget | null) =>
    t instanceof HTMLElement && (t.isContentEditable || t.closest('button, input, select, textarea, a[href]') !== null)
  const releaseSpace = () => {
    spaceDown = false
    svgEl.classList.remove('pan-ready')
  }

  window.addEventListener('keydown', (e) => {
    if (isInteractive(e.target)) return
    if (e.code === 'Space') {
      spaceDown = true
      svgEl.classList.add('pan-ready')
      e.preventDefault()
      return
    }
    // Ctrl・Cmd・Alt つきはブラウザの拡大縮小などに任せる
    if (e.ctrlKey || e.metaKey || e.altKey) return
    if (e.key === '+' || e.key === ';') zoomIn()
    else if (e.key === '-') zoomOut()
    else if (e.key === '0') home()
  })
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') releaseSpace()
  })
  // Space を押したまま別の窓へ移ると keyup が来ないので、離れたときに戻す
  window.addEventListener('blur', releaseSpace)

  // 窓の大きさが変わっても、左上の図面座標と倍率はそのまま
  new ResizeObserver(() => {
    if (!touched) view = fitRect(homeRect, size())
    redraw()
  }).observe(svgEl)

  draw()
  return {
    svg: svgEl,
    world,
    underlay,
    toolbar,
    side,
    getViewport: () => view,
    toWorld: (clientX, clientY) => {
      const r = svgEl.getBoundingClientRect()
      return screenToWorld(view, { x: clientX - r.left, y: clientY - r.top })
    },
    isPanKeyDown: () => spaceDown,
    setHome: (rect) => {
      homeRect = rect ?? DEFAULT_HOME
    },
    fitHome: home,
  }
}
