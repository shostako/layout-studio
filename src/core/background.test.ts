import { describe, expect, it } from 'vitest'
import { backgroundRect, calibrate, checkBackground, createBackground, DEFAULT_BACKGROUND_WIDTH_MM, paperMmPerPixel, paperScaleCalibration, pdfRenderScale, PDF_MAX_PIXELS } from './background'
import { applyCommand, type Command } from './commands'
import { createEmptyScene, type Scene } from './scene'

const bg = () => createBackground('data:image/png;base64,AAAA', 'plan.png', 1000, 500)

function ok(scene: Scene, cmd: Command): Scene {
  const r = applyCommand(scene, cmd)
  if (!r.ok) throw new Error(r.error)
  return r.scene
}

function err(scene: Scene, cmd: Command): string {
  const r = applyCommand(scene, cmd)
  if (r.ok) throw new Error('失敗するはずが通った')
  return r.error
}

describe('createBackground', () => {
  it('左上を原点に置き、仮に幅 20 m とみなす', () => {
    const b = bg()
    expect(b.calibrated).toBe(false)
    expect(backgroundRect(b)).toEqual({ x: 0, y: 0, width: DEFAULT_BACKGROUND_WIDTH_MM, height: 10000 })
  })
})

describe('calibrate', () => {
  it('2 点の距離が指定の長さになり、1 点目は動かない', () => {
    const b = { ...bg(), x: 100, y: 200 } // 20 mm/px
    const a = { x: 2100, y: 1200 } // 画像の (100, 50) px
    const p = { x: 2100 + 3000, y: 1200 + 4000 } // 今は 5000 mm 離れている
    const r = calibrate(b, a, p, 12000)
    if (!r.ok) throw new Error(r.error)
    const c = r.background
    expect(c.calibrated).toBe(true)
    expect(c.mmPerPixel).toBeCloseTo(48)
    // a は画像の (100, 50) px のまま同じ場所にある
    expect(c.x + 100 * c.mmPerPixel).toBeCloseTo(a.x)
    expect(c.y + 50 * c.mmPerPixel).toBeCloseTo(a.y)
    // b の画像上の点は 12000 mm 離れた所へ動く
    const pxB = { x: (p.x - b.x) / b.mmPerPixel, y: (p.y - b.y) / b.mmPerPixel }
    const nb = { x: c.x + pxB.x * c.mmPerPixel, y: c.y + pxB.y * c.mmPerPixel }
    expect(Math.hypot(nb.x - a.x, nb.y - a.y)).toBeCloseTo(12000)
  })

  it('距離が正でない、2 点が近すぎる、点が数でないものは断る', () => {
    const b = bg()
    const a = { x: 0, y: 0 }
    expect(calibrate(b, a, { x: 1000, y: 0 }, 0)).toMatchObject({ ok: false, error: expect.stringMatching('正の数') })
    expect(calibrate(b, a, { x: 1000, y: 0 }, NaN)).toMatchObject({ ok: false })
    expect(calibrate(b, a, { x: 5, y: 0 }, 1000)).toMatchObject({ ok: false, error: expect.stringMatching('近すぎ') })
    expect(calibrate(b, a, { x: NaN, y: 0 }, 1000)).toMatchObject({ ok: false, error: expect.stringMatching('数では') })
  })
})

describe('checkBackground', () => {
  it('空の画像、0 以下の大きさや縮尺、数でない位置を断る', () => {
    expect(checkBackground(bg())).toBeNull()
    expect(checkBackground({ ...bg(), src: '' })).toMatch('空')
    expect(checkBackground({ ...bg(), pixelWidth: 0 })).toMatch('大きさ')
    expect(checkBackground({ ...bg(), mmPerPixel: -1 })).toMatch('縮尺')
    expect(checkBackground({ ...bg(), x: Infinity })).toMatch('位置')
  })
})

describe('背景のコマンド', () => {
  it('置く・差し替える・外す。元のシーンは変えない', () => {
    const empty = createEmptyScene()
    const s1 = ok(empty, { type: 'setBackground', background: bg() })
    expect(s1.background?.name).toBe('plan.png')
    expect(empty.background).toBeNull()
    const s2 = ok(s1, { type: 'setBackground', background: { ...bg(), name: 'b.png' } })
    expect(s2.background?.name).toBe('b.png')
    expect(ok(s2, { type: 'setBackground', background: null }).background).toBeNull()
    expect(err(empty, { type: 'setBackground', background: { ...bg(), mmPerPixel: 0 } })).toMatch('縮尺')
  })

  it('縮尺合わせと移動は背景だけを変え、設備は動かさない', () => {
    const base = ok(createEmptyScene(), { type: 'setBackground', background: bg() })
    const withEq = ok(base, {
      type: 'add',
      equipment: { id: 'eq-1', kind: 'k', name: 'n', x: 500, y: 500, width: 100, depth: 100, rotation: 0, color: '#888', clearance: { top: 0, right: 0, bottom: 0, left: 0 } },
    })
    const cal = ok(withEq, { type: 'calibrateBackground', a: { x: 0, y: 0 }, b: { x: 10000, y: 0 }, distance: 30000 })
    expect(cal.background?.mmPerPixel).toBeCloseTo(60)
    expect(cal.equipment).toBe(withEq.equipment)
    const moved = ok(cal, { type: 'moveBackground', dx: -300, dy: 250 })
    expect(moved.background).toMatchObject({ x: -300, y: 250, mmPerPixel: cal.background!.mmPerPixel })
  })

  it('背景が無いときの縮尺合わせと移動は断る', () => {
    const empty = createEmptyScene()
    expect(err(empty, { type: 'calibrateBackground', a: { x: 0, y: 0 }, b: { x: 1, y: 0 }, distance: 1 })).toMatch('背景')
    expect(err(empty, { type: 'moveBackground', dx: 1, dy: 1 })).toMatch('背景')
  })
})

describe('PDF の図面', () => {
  it('A3 横（1190.64 × 841.92 pt）を 300 dpi で画像にすると長辺 4961 px', () => {
    const { scale, dpi } = pdfRenderScale(1190.64, 841.92)
    expect(Math.round(1190.64 * scale)).toBe(4961)
    expect(dpi).toBeCloseTo(300)
  })
  it('長辺が上限を超える紙は dpi を下げる', () => {
    // A0 の長辺 3370 pt を 300 dpi にすると 14042 px。上限 6000 px に収める
    const { scale, dpi } = pdfRenderScale(2384, 3370)
    expect(3370 * scale).toBeCloseTo(PDF_MAX_PIXELS)
    expect(dpi).toBeCloseTo((PDF_MAX_PIXELS / 3370) * 72)
  })
  it('紙の縮尺 1/400 を 300 dpi で読むと 1 px は 33.87 mm', () => {
    expect(paperMmPerPixel(300, 400)).toBeCloseTo(33.8667, 3)
    expect(paperMmPerPixel(72, 100)).toBeCloseTo(35.2778, 3)
  })
  it('紙の縮尺を 2 点と距離に直し、calibrate で当てると左上を動かさずにその縮尺になる', () => {
    const bg = { ...createBackground('data:,', 'a.pdf', 4961, 3508), x: 1000, y: 2000 }
    const c = paperScaleCalibration(bg, 300, 400)!
    const r = calibrate(bg, c.a, c.b, c.distance)
    if (!r.ok) throw new Error(r.error)
    expect(r.background.mmPerPixel).toBeCloseTo(paperMmPerPixel(300, 400))
    expect(r.background.x).toBeCloseTo(1000)
    expect(r.background.y).toBeCloseTo(2000)
  })
  it('縮尺や dpi が正の数でなければ null', () => {
    const bg = createBackground('data:,', 'a.pdf', 100, 100)
    expect(paperScaleCalibration(bg, 300, 0)).toBeNull()
    expect(paperScaleCalibration(bg, Number.NaN, 400)).toBeNull()
  })
})
