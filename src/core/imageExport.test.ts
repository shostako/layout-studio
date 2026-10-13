import { describe, expect, it } from 'vitest'
import { createBackground } from './background'
import { exportFrame, imageFileName, scaleBarLength } from './imageExport'
import { createEmptyScene, type Equipment } from './scene'
import { rectSite } from './site'

const eq = (id: string, x: number, y: number): Equipment => ({
  id,
  kind: 'weighing-scale',
  name: id,
  x,
  y,
  width: 1000,
  depth: 1000,
  rotation: 0,
  color: '#888',
  clearance: { top: 500, right: 500, bottom: 500, left: 500 },
})

describe('exportFrame', () => {
  it('何も無ければ null', () => {
    expect(exportFrame(createEmptyScene())).toBeNull()
  })

  it('設備の余白まで含め、周りに余白を足して、長い辺を決めた px にする', () => {
    const s = { ...createEmptyScene(), equipment: [eq('a', 1000, 1000), eq('b', 20000, 5000)] }
    const f = exportFrame(s, 2000)!
    // 余白込みの範囲: x 0〜21000、y 0〜6000。周りに 21000 × 0.03 = 630 mm
    expect(f.view).toEqual({ x: -630, y: -630, width: 22260, height: 7260 })
    expect(f.width).toBe(2000)
    expect(f.height).toBe(Math.round(7260 * (2000 / 22260)))
  })

  it('敷地も範囲に入れる', () => {
    const s = { ...createEmptyScene(), site: rectSite(0, 0, 30000, 20000), equipment: [eq('a', 1000, 1000)] }
    const f = exportFrame(s)!
    expect(f.view.x).toBeLessThanOrEqual(0)
    expect(f.view.x + f.view.width).toBeGreaterThanOrEqual(30000)
    expect(f.view.y + f.view.height).toBeGreaterThanOrEqual(20000)
  })

  it('背景を隠しているときは、背景を範囲に入れない', () => {
    const background = createBackground('data:image/png;base64,', 'bg.png', 1000, 1000) // 幅 20 m の背景
    const s = { ...createEmptyScene(), background, equipment: [eq('a', 50000, 50000)] }
    const shown = exportFrame(s)!
    const hidden = exportFrame(s, undefined, false)!
    expect(shown.view.width).toBeGreaterThan(50000)
    expect(hidden.view.width).toBeLessThan(5000)
    expect(exportFrame({ ...createEmptyScene(), background }, undefined, false)).toBeNull()
  })

  it('大きさは上限で止める', () => {
    const s = { ...createEmptyScene(), equipment: [eq('a', 0, 0)] }
    expect(Math.max(exportFrame(s, 1e9)!.width, exportFrame(s, 1e9)!.height)).toBe(8000)
  })
})

describe('imageFileName', () => {
  it('日時から名前を作る（JSON の保存と同じ形）', () => {
    expect(imageFileName(new Date(2026, 9, 3, 9, 5))).toBe('layout-20261003-0905.png')
  })
})

describe('scaleBarLength', () => {
  it('幅の 1/5 を超えない 1・2・5 × 10^n', () => {
    expect(scaleBarLength(56000)).toBe(10000)
    expect(scaleBarLength(30000)).toBe(5000)
    expect(scaleBarLength(12000)).toBe(2000)
  })
})
