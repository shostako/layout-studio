// 図面を画像（PNG）に書き出すときの、写す範囲と画像の大きさ。DOM に触らない。
// 写す範囲は、背景の図面・敷地・設備（余白まで）・通路の帯をまとめて囲む長方形に、周りの余白を足したもの。
import { backgroundRect } from './background'
import { aisleBounds, boundsOf } from './compare'
import { clearanceRect, type Scene } from './scene'
import { siteBounds } from './site'
import type { Rect } from './viewport'

// 画像の長い辺の px（印刷や資料に貼っても粗く見えない大きさ）。ブラウザが扱える大きさに収める
export const EXPORT_LONG_SIDE_PX = 3200
export const EXPORT_MAX_PX = 8000
// 周りの余白（写す範囲の長い辺に対する割合と、最小の mm）
const MARGIN_RATIO = 0.03
const MARGIN_MIN_MM = 500

export type ExportFrame = {
  view: Rect // 写す図面の範囲（mm）
  width: number // 画像の幅（px）
  height: number // 画像の高さ（px）
  pxPerMm: number
}

// 何も無いシーンなら null（書き出すものが無い）。背景を隠しているとき（欄の「表示」を外したとき）は、背景を範囲に入れない
export function exportFrame(scene: Scene, longSidePx = EXPORT_LONG_SIDE_PX, withBackground = true): ExportFrame | null {
  const rects: Rect[] = [
    ...(scene.background && withBackground ? [backgroundRect(scene.background)] : []),
    ...(scene.site ? [siteBounds(scene.site)] : []),
    ...scene.equipment.map(clearanceRect),
    ...aisleBounds(scene),
  ]
  const b = boundsOf(rects)
  if (!b || b.width <= 0 || b.height <= 0) return null
  const m = Math.max(MARGIN_MIN_MM, Math.max(b.width, b.height) * MARGIN_RATIO)
  const view = { x: b.x - m, y: b.y - m, width: b.width + 2 * m, height: b.height + 2 * m }
  const long = Math.min(EXPORT_MAX_PX, Math.max(1, longSidePx))
  const pxPerMm = long / Math.max(view.width, view.height)
  return {
    view,
    width: Math.max(1, Math.round(view.width * pxPerMm)),
    height: Math.max(1, Math.round(view.height * pxPerMm)),
    pxPerMm,
  }
}

// 書き出すファイルの名前（日時）。JSON の保存と同じ形にする。日本語の名前は、ブラウザによっては付かず「download」になるので入れない
// （案の名前は画像の左下に入れる）
export function imageFileName(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `layout-${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}.png`
}

// 縮尺の目盛りの長さ（mm）: 画像の幅の 1/5 を超えない 1・2・5 × 10^n の長さ
export function scaleBarLength(viewWidthMm: number): number {
  const target = viewWidthMm / 5
  const decade = 10 ** Math.floor(Math.log10(target))
  for (const m of [5, 2, 1]) if (m * decade <= target) return m * decade
  return decade
}
