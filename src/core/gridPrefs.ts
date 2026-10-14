// マス目とスナップの設定と、その既定（使う人が「既定にする」で覚えさせた値）。DOM に触らない。
// どちらも見え方と操作の補助で、シーンには入れない（保存も元に戻すもしない）。既定はブラウザに覚えておく（src/ui/grid.ts）。

import { DEFAULT_SNAP, SNAP_STEPS } from './placement'

// 選べるマス目の大きさ（mm）。0 は自動（拡大縮小に合わせて 1・2・5 × 10^n mm を選ぶ）
export const GRID_CELLS: readonly number[] = [0, 10, 50, 100, 200, 500, 1000, 2000, 5000]

export type GridPrefs = { grid: number; snap: number }

// 何も覚えていないときの既定: マス目は自動、スナップは 100 mm
export const FACTORY_GRID_PREFS: GridPrefs = { grid: 0, snap: DEFAULT_SNAP }

// 覚えておいた文字列を読む。読めない・選べない値なら、その項目は工場の既定にする
export function parseGridPrefs(text: string | null): GridPrefs {
  let v: unknown = null
  try {
    v = text ? JSON.parse(text) : null
  } catch {
    v = null
  }
  const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>
  const pick = (x: unknown, list: readonly number[], fallback: number) => (typeof x === 'number' && list.includes(x) ? x : fallback)
  return { grid: pick(o.grid, GRID_CELLS, FACTORY_GRID_PREFS.grid), snap: pick(o.snap, SNAP_STEPS, FACTORY_GRID_PREFS.snap) }
}

export function formatGridPrefs(p: GridPrefs): string {
  return JSON.stringify({ grid: p.grid, snap: p.snap })
}
