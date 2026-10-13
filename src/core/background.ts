// 背景の画像（建物の図面）と縮尺合わせ。DOM に触らない。
// 画像の 1 px が何 mm かを mmPerPixel で持ち、画像の左上を図面の座標（mm）の x, y に置く。
// 縮尺合わせは「図面の上の 2 点と、その間の本当の距離」から倍率を出し、1 点目を動かさずに画像を拡大縮小する。

import type { Point, Rect } from './viewport'

export type Background = {
  src: string // 画像の data URL。シーンの JSON だけで図面が戻るよう、中身ごと持つ
  name: string // 元のファイル名（表示用）
  pixelWidth: number // 画像の大きさ（px）
  pixelHeight: number
  x: number // 画像の左上が来る図面の座標（mm）
  y: number
  mmPerPixel: number // 画像の 1 px が何 mm か
  calibrated: boolean // 2 点で縮尺を合わせたか。false の間は仮の縮尺
}

// 読み込んだ直後の仮の縮尺: 画像の幅を 20 m とみなす（最初の表示範囲と同じ）
export const DEFAULT_BACKGROUND_WIDTH_MM = 20000

export function createBackground(src: string, name: string, pixelWidth: number, pixelHeight: number): Background {
  return {
    src,
    name,
    pixelWidth,
    pixelHeight,
    x: 0,
    y: 0,
    mmPerPixel: DEFAULT_BACKGROUND_WIDTH_MM / pixelWidth,
    calibrated: false,
  }
}

// 背景が図面の上で占める長方形（mm）
export function backgroundRect(bg: Background): Rect {
  return { x: bg.x, y: bg.y, width: bg.pixelWidth * bg.mmPerPixel, height: bg.pixelHeight * bg.mmPerPixel }
}

// 背景として受け付ける形か。理由つきで断る（null なら問題なし）
export function checkBackground(bg: Background): string | null {
  if (typeof bg.src !== 'string' || bg.src === '') return '背景の画像が空です'
  const positive = (v: number) => Number.isFinite(v) && v > 0
  if (!positive(bg.pixelWidth) || !positive(bg.pixelHeight)) return '背景の画像の大きさが正の数ではありません'
  if (!positive(bg.mmPerPixel)) return '背景の縮尺が正の数ではありません'
  if (!Number.isFinite(bg.x) || !Number.isFinite(bg.y)) return '背景の位置が数ではありません'
  return null
}

// いまの図面の上で a と b を distance mm 離れているとみなし、a を動かさずに背景を拡大縮小する
export function calibrate(
  bg: Background,
  a: Point,
  b: Point,
  distance: number,
): { ok: true; background: Background } | { ok: false; error: string } {
  if (![a.x, a.y, b.x, b.y].every(Number.isFinite)) return { ok: false, error: '縮尺合わせの点が数ではありません' }
  if (!(Number.isFinite(distance) && distance > 0)) return { ok: false, error: '距離は正の数（mm）にしてください' }
  const now = Math.hypot(b.x - a.x, b.y - a.y)
  // 画像の 1 px より近い 2 点では、倍率がまともに決まらない
  if (!(now >= bg.mmPerPixel)) return { ok: false, error: '2 点が近すぎます。離れた 2 点を選んでください' }
  const k = distance / now
  return {
    ok: true,
    background: {
      ...bg,
      mmPerPixel: bg.mmPerPixel * k,
      x: a.x + (bg.x - a.x) * k,
      y: a.y + (bg.y - a.y) * k,
      calibrated: true,
    },
  }
}
