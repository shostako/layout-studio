// 画面の表示範囲（拡大縮小と移動）とグリッドの計算。DOM に触らない。
// 画面の座標は px、図面の座標は mm。screen = (world - origin) * scale。
// 表示範囲はシーンに含めない（保存も元に戻すもしない）。見え方であって、案の中身ではないため。

export type Point = { x: number; y: number }
export type Size = { width: number; height: number }
export type Rect = { x: number; y: number; width: number; height: number }

export type Viewport = {
  originX: number // 画面の左上に来る図面の座標（mm）
  originY: number
  scale: number // 1 mm が何 px か
}

// 1 px = 500 mm（画面 1000 px で 500 m）から 1 mm = 4 px まで
export const MIN_SCALE = 0.002
export const MAX_SCALE = 4

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
}

export function worldToScreen(view: Viewport, p: Point): Point {
  return { x: (p.x - view.originX) * view.scale, y: (p.y - view.originY) * view.scale }
}

export function screenToWorld(view: Viewport, p: Point): Point {
  return { x: p.x / view.scale + view.originX, y: p.y / view.scale + view.originY }
}

// 画面上の点 at を動かさずに factor 倍する。上下限で止まったら、その倍率で止める
export function zoomAt(view: Viewport, at: Point, factor: number): Viewport {
  const scale = clampScale(view.scale * factor)
  const anchor = screenToWorld(view, at)
  return { originX: anchor.x - at.x / scale, originY: anchor.y - at.y / scale, scale }
}

// 画面の上で (dx, dy) px だけ図面を引きずる
export function panBy(view: Viewport, dx: number, dy: number): Viewport {
  return { ...view, originX: view.originX - dx / view.scale, originY: view.originY - dy / view.scale }
}

// 図面の範囲 rect が画面 screen の中央に収まるようにする。margin は画面の端に残す px
export function fitRect(rect: Rect, screen: Size, margin = 24): Viewport {
  const w = Math.max(1, screen.width - 2 * margin)
  const h = Math.max(1, screen.height - 2 * margin)
  const scale = clampScale(Math.min(w / Math.max(rect.width, 1e-9), h / Math.max(rect.height, 1e-9)))
  const cx = rect.x + rect.width / 2
  const cy = rect.y + rect.height / 2
  return { originX: cx - screen.width / 2 / scale, originY: cy - screen.height / 2 / scale, scale }
}

// 画面に見えている図面の範囲
export function visibleRect(view: Viewport, screen: Size): Rect {
  return { x: view.originX, y: view.originY, width: screen.width / view.scale, height: screen.height / view.scale }
}

export type GridStep = { minor: number; major: number } // mm

// 細線の間隔が minPx 以上になる 1・2・5 × 10^n mm を選ぶ。太線は 10 mm の桁がそろう間隔にする
export function gridStep(scale: number, minPx = 10): GridStep {
  const target = minPx / scale
  let decade = 10 ** Math.floor(Math.log10(target))
  for (;;) {
    for (const m of [1, 2, 5]) {
      const minor = m * decade
      // 浮動小数の誤差を落とす（0.1 の倍数など）
      const step = Number(minor.toPrecision(12))
      if (step >= target * (1 - 1e-9)) return { minor: step, major: m === 2 ? step * 5 : step * 10 }
    }
    decade *= 10
  }
}

export type GridLines = { xs: number[]; ys: number[]; majorXs: number[]; majorYs: number[] } // mm

// 見えている範囲に引く線の図面座標。細線と太線を分けて返す（太線の位置に細線は返さない）
export function gridLines(view: Viewport, screen: Size, step: GridStep): GridLines {
  const r = visibleRect(view, screen)
  const split = (from: number, to: number) => {
    const minor: number[] = []
    const major: number[] = []
    const ratio = Math.round(step.major / step.minor)
    for (let i = Math.ceil(from / step.minor); i * step.minor <= to; i++) {
      const v = Number((i * step.minor).toPrecision(12))
      if (i % ratio === 0) major.push(v)
      else minor.push(v)
    }
    return { minor, major }
  }
  const x = split(r.x, r.x + r.width)
  const y = split(r.y, r.y + r.height)
  return { xs: x.minor, ys: y.minor, majorXs: x.major, majorYs: y.major }
}

// 長さの表示。1000 mm 以上は m で出す
export function formatLength(mm: number): string {
  if (Math.abs(mm) >= 1000) return `${Number((mm / 1000).toPrecision(6))} m`
  return `${Number(mm.toPrecision(6))} mm`
}
