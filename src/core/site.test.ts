import { describe, expect, it } from 'vitest'
import { applyCommand } from './commands'
import { SCENE_VERSION, createEmptyScene, type Equipment, type Scene } from './scene'
import { checkSite, equipmentOutsideSite, pointInSite, rectInSite, rectSite, siteArea, siteBounds, type Site } from './site'
import { parseScene, serializeScene } from './sceneFile'

const site = (...xy: [number, number][]): Site => ({ points: xy.map(([x, y]) => ({ x, y })) })

// 30 m × 20 m の長方形
const box = rectSite(0, 0, 30000, 20000)
// L 字: 30 m × 20 m の右上 10 m × 10 m を欠いたもの
const ell = site([0, 0], [20000, 0], [20000, 10000], [30000, 10000], [30000, 20000], [0, 20000])

function eq(id: string, over: Partial<Equipment> = {}): Equipment {
  return { id, kind: 'molding-machine', name: id, x: 5000, y: 5000, width: 4000, depth: 2000, rotation: 0, color: '#888', ...over }
}

function ok(scene: Scene, cmd: Parameters<typeof applyCommand>[1]): Scene {
  const r = applyCommand(scene, cmd)
  if (!r.ok) throw new Error(r.error)
  return r.scene
}

describe('siteArea と siteBounds', () => {
  it('長方形・L 字の面積（mm²）。頂点の向きは問わない', () => {
    expect(siteArea(box)).toBe(600_000_000)
    expect(siteArea(ell)).toBe(500_000_000)
    expect(siteArea({ points: [...ell.points].reverse() })).toBe(500_000_000)
    expect(siteArea(site([0, 0], [4000, 0], [0, 3000]))).toBe(6_000_000)
  })

  it('囲む長方形', () => {
    expect(siteBounds(site([1000, 500], [4000, 2000], [-200, 3000]))).toEqual({ x: -200, y: 500, width: 4200, height: 2500 })
  })
})

describe('checkSite', () => {
  it('ふつうの多角形は通す', () => {
    expect(checkSite(box)).toBeNull()
    expect(checkSite(ell)).toBeNull()
  })

  it('頂点が足りない・数でない・同じ点が続く・面積 0 を断る', () => {
    expect(checkSite(site([0, 0], [1000, 0]))).toMatch('3 つ以上')
    expect(checkSite({ points: [{ x: 0, y: 0 }, { x: NaN, y: 0 }, { x: 0, y: 1 }] })).toMatch('数ではありません')
    expect(checkSite(site([0, 0], [1000, 0], [1000, 0], [0, 1000]))).toMatch('同じ点')
    expect(checkSite(site([0, 0], [1000, 0], [0, 1000], [0, 0]))).toMatch('同じ点')
    expect(checkSite(site([0, 0], [1000, 0], [2000, 0]))).toMatch(/重なって|面積が 0/)
    expect(checkSite({} as Site)).toMatch('points')
  })

  it('辺どうしが交わる（8 の字、触れる）ものを断る', () => {
    expect(checkSite(site([0, 0], [1000, 1000], [1000, 0], [0, 1000]))).toMatch('交わって')
    // 頂点が離れた辺の上に乗る
    expect(checkSite(site([0, 0], [2000, 0], [2000, 2000], [1000, 0], [0, 2000]))).toMatch('交わって')
  })

  it('隣の辺が折り返して重なるものを断る', () => {
    expect(checkSite(site([0, 0], [2000, 0], [1000, 0], [1000, 1000]))).toMatch('折り返して')
  })
})

describe('pointInSite と rectInSite', () => {
  it('内・外・辺の上', () => {
    expect(pointInSite(ell, { x: 5000, y: 5000 })).toBe(true)
    expect(pointInSite(ell, { x: 25000, y: 5000 })).toBe(false) // 欠いた角
    expect(pointInSite(ell, { x: 20000, y: 5000 })).toBe(true) // 辺の上
    expect(pointInSite(ell, { x: 0, y: 0 })).toBe(true) // 頂点
    expect(pointInSite(ell, { x: -1, y: 5000 })).toBe(false)
  })

  it('長方形が収まる・辺に接する・はみ出す', () => {
    expect(rectInSite(box, { x: 1000, y: 1000, width: 4000, height: 2000 })).toBe(true)
    expect(rectInSite(box, { x: 0, y: 0, width: 30000, height: 20000 })).toBe(true) // ぴったり
    expect(rectInSite(box, { x: 26000, y: 1000, width: 4000, height: 2000 })).toBe(true) // 壁に寄せる
    expect(rectInSite(box, { x: 26001, y: 1000, width: 4000, height: 2000 })).toBe(false)
    expect(rectInSite(box, { x: 40000, y: 1000, width: 4000, height: 2000 })).toBe(false) // 丸ごと外
  })

  it('L 字の欠いた角にかかると、四隅が内側でもはみ出し', () => {
    // 内側の角 (20000, 10000) をまたぐ
    expect(rectInSite(ell, { x: 18000, y: 8000, width: 4000, height: 4000 })).toBe(false)
    // 内側の角に接するだけなら収まる
    expect(rectInSite(ell, { x: 16000, y: 6000, width: 4000, height: 4000 })).toBe(true)
    expect(rectInSite(ell, { x: 20000, y: 10000, width: 4000, height: 4000 })).toBe(true)
  })

  it('細い切り込みが長方形を横切ると、四隅と中心が内側でもはみ出し', () => {
    // 下から上へ、x = 4990〜5010 の切り込み（上端は y = 1000）
    const slit = site([0, 0], [10000, 0], [10000, 10000], [5010, 10000], [5010, 1000], [4990, 1000], [4990, 10000], [0, 10000])
    expect(rectInSite(slit, { x: 3000, y: 2000, width: 1000, height: 1000 })).toBe(true)
    expect(rectInSite(slit, { x: 3000, y: 2000, width: 4000, height: 1000 })).toBe(false)
  })

  it('外形の凹みに長方形がぴったりはまるのは、はみ出し', () => {
    // 長方形の外形から、下辺の中ほどを 2000 × 2000 くぼませる
    const notch = site([0, 0], [10000, 0], [10000, 10000], [6000, 10000], [6000, 8000], [4000, 8000], [4000, 10000], [0, 10000])
    expect(rectInSite(notch, { x: 4000, y: 8000, width: 2000, height: 2000 })).toBe(false)
  })
})

describe('setSite コマンドと equipmentOutsideSite', () => {
  it('外形を置く・消す。外形が無ければはみ出しは無い', () => {
    let s = ok(createEmptyScene(), { type: 'add', equipment: eq('a', { x: 50000 }) })
    expect(equipmentOutsideSite(s)).toEqual([])
    s = ok(s, { type: 'setSite', site: box })
    expect(s.site).toEqual(box)
    expect(equipmentOutsideSite(s)).toEqual(['a'])
    s = ok(s, { type: 'setSite', site: null })
    expect(s.site).toBeNull()
  })

  it('回転した外接の長方形で判定する', () => {
    // 幅 4000 × 奥行 2000、中心 (29000, 5000): 回転 0 では x が 31000 まで出る。90° なら 30000 に収まる
    let s = ok(createEmptyScene(), { type: 'setSite', site: box })
    s = ok(s, { type: 'add', equipment: eq('a', { x: 29000, y: 5000 }) })
    expect(equipmentOutsideSite(s)).toEqual(['a'])
    s = ok(s, { type: 'rotate', ids: ['a'], quarterTurns: 1 })
    expect(equipmentOutsideSite(s)).toEqual([])
  })

  it('不正な外形は理由つきで断り、シーンを変えない', () => {
    const s = createEmptyScene()
    const r = applyCommand(s, { type: 'setSite', site: site([0, 0], [1000, 1000], [1000, 0], [0, 1000]) })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch('交わって')
  })

  it('知らない項目は落とす', () => {
    const s = ok(createEmptyScene(), { type: 'setSite', site: { points: [...box.points.map((p) => ({ ...p, z: 1 }))], memo: 'x' } as Site })
    expect(s.site).toEqual(box)
  })
})

describe('ファイルの敷地', () => {
  it('書き出して読み直すと外形が戻る', () => {
    const s = ok(createEmptyScene(), { type: 'setSite', site: ell })
    const r = parseScene(serializeScene(s))
    expect(r.ok && r.scene).toEqual(s)
  })

  it('版 1 のファイルは敷地なしで読む', () => {
    const r = parseScene(JSON.stringify({ version: 1, background: null, equipment: [eq('a')] }))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.scene.version).toBe(SCENE_VERSION)
      expect(r.scene.site).toBeNull()
      expect(r.scene.equipment).toHaveLength(1)
    }
  })

  it('壊れた外形のファイルは断る', () => {
    const r = parseScene(JSON.stringify({ version: 2, background: null, site: { points: [{ x: 0, y: 0 }] }, equipment: [] }))
    expect(r.ok).toBe(false)
  })
})
