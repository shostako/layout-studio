import { describe, expect, it } from 'vitest'
import {
  MAX_SCALE,
  MIN_SCALE,
  fitRect,
  formatLength,
  gridLines,
  fixedGridStep,
  gridStep,
  panBy,
  pinchView,
  screenToWorld,
  worldToScreen,
  zoomAt,
  type Viewport,
} from './viewport'

const view: Viewport = { originX: 1000, originY: 2000, scale: 0.05 }

describe('座標の変換', () => {
  it('図面→画面→図面で元に戻る', () => {
    const p = { x: 12345, y: -678 }
    const q = screenToWorld(view, worldToScreen(view, p))
    expect(q.x).toBeCloseTo(p.x, 6)
    expect(q.y).toBeCloseTo(p.y, 6)
  })

  it('origin が画面の左上に来る', () => {
    expect(worldToScreen(view, { x: 1000, y: 2000 })).toEqual({ x: 0, y: 0 })
  })
})

describe('zoomAt', () => {
  it('指した点の下の図面座標は動かない', () => {
    const at = { x: 300, y: 200 }
    const before = screenToWorld(view, at)
    const z = zoomAt(view, at, 2.5)
    expect(z.scale).toBeCloseTo(0.125)
    const after = screenToWorld(z, at)
    expect(after.x).toBeCloseTo(before.x, 6)
    expect(after.y).toBeCloseTo(before.y, 6)
  })

  it('倍率は上下限で止まる', () => {
    expect(zoomAt(view, { x: 0, y: 0 }, 1e9).scale).toBe(MAX_SCALE)
    expect(zoomAt(view, { x: 0, y: 0 }, 1e-9).scale).toBe(MIN_SCALE)
  })
})

describe('panBy', () => {
  it('画面で右へ引くと、図面は左の部分が見える', () => {
    const p = panBy(view, 100, -50)
    expect(p.originX).toBeCloseTo(1000 - 100 / 0.05)
    expect(p.originY).toBeCloseTo(2000 + 50 / 0.05)
    expect(p.scale).toBe(view.scale)
  })
})

describe('pinchView', () => {
  const a = { x: 100, y: 100 }
  const b = { x: 300, y: 100 }

  it('指の間を 2 倍に広げると 2 倍になり、中点の下の図面座標は動かない', () => {
    const before = screenToWorld(view, { x: 200, y: 100 })
    const p = pinchView(view, [a, b], [{ x: 0, y: 100 }, { x: 400, y: 100 }])
    expect(p.scale).toBeCloseTo(view.scale * 2)
    const after = screenToWorld(p, { x: 200, y: 100 })
    expect(after.x).toBeCloseTo(before.x, 6)
    expect(after.y).toBeCloseTo(before.y, 6)
  })

  it('指の間が同じまま動かすと、倍率はそのままで図面がついてくる', () => {
    const before = screenToWorld(view, { x: 200, y: 100 })
    const p = pinchView(view, [a, b], [{ x: 150, y: 160 }, { x: 350, y: 160 }])
    expect(p.scale).toBeCloseTo(view.scale)
    const after = screenToWorld(p, { x: 250, y: 160 })
    expect(after.x).toBeCloseTo(before.x, 6)
    expect(after.y).toBeCloseTo(before.y, 6)
  })

  it('広げながら動かすと、始めの中点にあった点が新しい中点へ来る', () => {
    const before = screenToWorld(view, { x: 200, y: 100 })
    const p = pinchView(view, [a, b], [{ x: 50, y: 300 }, { x: 350, y: 300 }])
    expect(p.scale).toBeCloseTo(view.scale * 1.5)
    const after = screenToWorld(p, { x: 200, y: 300 })
    expect(after.x).toBeCloseTo(before.x, 6)
    expect(after.y).toBeCloseTo(before.y, 6)
  })

  it('倍率は上下限で止まり、そのときも中点は合う', () => {
    const before = screenToWorld(view, { x: 200, y: 100 })
    const p = pinchView(view, [a, b], [{ x: 199.99, y: 100 }, { x: 200.01, y: 100 }])
    expect(p.scale).toBe(MIN_SCALE)
    const after = screenToWorld(p, { x: 200, y: 100 })
    expect(after.x).toBeCloseTo(before.x, 6)
  })

  it('始めの 2 点がほぼ重なっているときは移動だけにする', () => {
    const p = pinchView(view, [a, { x: 100.5, y: 100 }], [{ x: 0, y: 0 }, { x: 400, y: 0 }])
    expect(p.scale).toBe(view.scale)
  })
})

describe('fitRect', () => {
  it('範囲が余白を残して画面に収まり、中央に来る', () => {
    const v = fitRect({ x: 0, y: 0, width: 20000, height: 15000 }, { width: 848, height: 448 }, 24)
    // 縦が効く: 400 px / 15000 mm
    expect(v.scale).toBeCloseTo(400 / 15000)
    const c = worldToScreen(v, { x: 10000, y: 7500 })
    expect(c.x).toBeCloseTo(424)
    expect(c.y).toBeCloseTo(224)
  })
})

describe('gridStep', () => {
  it('細線の間隔は 1・2・5 の系列で、画面で minPx 以上になる最小のもの', () => {
    // 0.05 px/mm、10 px 以上 → 200 mm
    expect(gridStep(0.05, 10)).toEqual({ minor: 200, major: 1000 })
    // 0.1 px/mm → 100 mm、太線 1000 mm
    expect(gridStep(0.1, 10)).toEqual({ minor: 100, major: 1000 })
    // 0.02 px/mm → 500 mm、太線 5000 mm
    expect(gridStep(0.02, 10)).toEqual({ minor: 500, major: 5000 })
    // 4 px/mm → 2.5 mm 以上 → 5 mm
    expect(gridStep(4, 10)).toEqual({ minor: 5, major: 50 })
  })

  it('どの倍率でも細線の間隔が minPx 以上で、その 2.5 倍未満', () => {
    for (let s = MIN_SCALE; s <= MAX_SCALE; s *= 1.37) {
      const { minor } = gridStep(s, 10)
      expect(minor * s).toBeGreaterThanOrEqual(10 - 1e-9)
      expect(minor * s).toBeLessThan(25 + 1e-9)
    }
  })
})

describe('fixedGridStep', () => {
  it('マス目の大きさを決めたら、その間隔で引き、太線は 10 マスごと', () => {
    // 0.1 px/mm で 100 mm は 10 px
    expect(fixedGridStep(100, 0.1)).toEqual({ minor: 100, major: 1000, thinned: false })
  })
  it('縮小して細かくなりすぎたら 10 倍ずつ間引く', () => {
    // 0.01 px/mm で 100 mm は 1 px → 1000 mm（10 px）
    expect(fixedGridStep(100, 0.01)).toEqual({ minor: 1000, major: 10000, thinned: true })
    // 0.002 px/mm で 10 mm → 10000 mm（20 px）
    expect(fixedGridStep(10, 0.002)).toEqual({ minor: 10000, major: 100000, thinned: true })
  })
})

describe('gridLines', () => {
  it('見えている範囲の線を、太線と細線に分けて返す', () => {
    const v: Viewport = { originX: -150, originY: 0, scale: 0.1 }
    const lines = gridLines(v, { width: 300, height: 100 }, { minor: 100, major: 1000 })
    // x: -150 .. 2850
    expect(lines.majorXs).toEqual([0, 1000, 2000])
    expect(lines.xs).toEqual([-100, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900, 2100, 2200, 2300, 2400, 2500, 2600, 2700, 2800])
    // y: 0 .. 1000
    expect(lines.majorYs).toEqual([0, 1000])
    expect(lines.ys).toHaveLength(9)
  })
})

describe('formatLength', () => {
  it('1000 mm 以上は m', () => {
    expect(formatLength(500)).toBe('500 mm')
    expect(formatLength(1000)).toBe('1 m')
    expect(formatLength(25000)).toBe('25 m')
  })
})
