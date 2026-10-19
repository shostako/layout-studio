import { describe, expect, it } from 'vitest'
import type { Aisle } from './aisle'
import { aislePieces, clearanceEquipment, clearanceZone, clipToRect, convexOverlapsRect, findOverlaps, overlappingEquipment, rectOverlap } from './overlap'
import { createEmptyScene, type Equipment, type Rotation, type Scene } from './scene'

// 左上 (x, y)、幅 w、奥行 d の設備（回転 0）
function eq(id: string, x: number, y: number, w: number, d: number, rotation: Rotation = 0): Equipment {
  const turned = rotation === 90 || rotation === 270
  const fw = turned ? d : w
  const fh = turned ? w : d
  return { id, kind: 'molding-machine', name: id, x: x + fw / 2, y: y + fh / 2, width: w, depth: d, rotation, color: '#888888', clearance: { top: 0, right: 0, bottom: 0, left: 0 } }
}

function aisle(id: string, xy: [number, number][], over: Partial<Aisle> = {}): Aisle {
  return { id, name: id, points: xy.map(([x, y]) => ({ x, y })), width: 1000, closed: false, ...over }
}

function scene(equipment: Equipment[], aisles: Aisle[] = []): Scene {
  return { ...createEmptyScene(), equipment, aisles }
}

const area = (poly: { x: number; y: number }[]) =>
  Math.abs(poly.reduce((s, p, i) => s + p.x * poly[(i + 1) % poly.length]!.y - poly[(i + 1) % poly.length]!.x * p.y, 0)) / 2

describe('rectOverlap', () => {
  it('内部が重なれば重なった長方形を返す', () => {
    expect(rectOverlap({ x: 0, y: 0, width: 100, height: 100 }, { x: 60, y: 30, width: 100, height: 100 })).toEqual({
      x: 60,
      y: 30,
      width: 40,
      height: 70,
    })
  })

  it('辺や角で接するだけなら重ならない', () => {
    const a = { x: 0, y: 0, width: 100, height: 100 }
    expect(rectOverlap(a, { x: 100, y: 0, width: 50, height: 100 })).toBeNull()
    expect(rectOverlap(a, { x: 100, y: 100, width: 50, height: 50 })).toBeNull()
    expect(rectOverlap(a, { x: 200, y: 0, width: 50, height: 50 })).toBeNull()
  })
})

describe('設備どうし', () => {
  it('すき間なく並べたものは重ならない。1 mm 入り込むと重なる', () => {
    expect(findOverlaps(scene([eq('a', 0, 0, 3000, 2000), eq('b', 3000, 0, 3000, 2000)]))).toEqual([])
    const o = findOverlaps(scene([eq('a', 0, 0, 3000, 2000), eq('b', 2999, 0, 3000, 2000)]))
    expect(o).toEqual([{ kind: 'equipment', a: 'a', b: 'b', region: { x: 2999, y: 0, width: 1, height: 2000 } }])
  })

  it('回転を考える', () => {
    // 3000 × 1000 を 90° 回すと 1000 × 3000。下に置いた設備に届く
    const a = eq('a', 0, 0, 3000, 1000, 90)
    expect(findOverlaps(scene([a, eq('b', 0, 2500, 1000, 1000)]))).toHaveLength(1)
    expect(findOverlaps(scene([eq('a', 0, 0, 3000, 1000), eq('b', 0, 2500, 1000, 1000)]))).toEqual([])
  })

  it('3 台が重なれば組ごとに挙げ、かかわる設備を集める', () => {
    const o = findOverlaps(scene([eq('a', 0, 0, 1000, 1000), eq('b', 500, 0, 1000, 1000), eq('c', 800, 0, 1000, 1000), eq('d', 5000, 0, 10, 10)]))
    expect(o.map((x) => (x.kind === 'equipment' ? `${x.a}-${x.b}` : ''))).toEqual(['a-b', 'a-c', 'b-c'])
    expect([...overlappingEquipment(o)].sort()).toEqual(['a', 'b', 'c'])
  })
})

describe('通路の形', () => {
  it('直角の角は外側が正方形で埋まる', () => {
    // (0, 0) → (10000, 0) → (10000, 5000)、幅 1000
    const pieces = aislePieces(aisle('x', [[0, 0], [10000, 0], [10000, 5000]]))
    expect(pieces).toHaveLength(3)
    const join = pieces[2]!
    expect(area(join)).toBeCloseTo(500 * 500)
    const xs = join.map((p) => p.x)
    const ys = join.map((p) => p.y)
    expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)].map((v) => Math.round(v))).toEqual([
      10000, 10500, -500, 0,
    ])
  })

  it('周回はすべての頂点に角の埋めを持つ。まっすぐな頂点には埋めが要らない', () => {
    const square = aisle('x', [[0, 0], [4000, 0], [4000, 4000], [0, 4000]], { closed: true })
    expect(aislePieces(square)).toHaveLength(8)
    expect(aislePieces(aisle('x', [[0, 0], [2000, 0], [4000, 0]]))).toHaveLength(2)
  })

  it('尖りすぎる角は bevel（三角形）に落とす', () => {
    // ほぼ折り返す角（約 11°）
    const pieces = aislePieces(aisle('x', [[0, 0], [10000, 0], [0, 2000]]))
    expect(pieces[2]).toHaveLength(3)
    // 60° の角（尖りの比 2）は miter のまま
    expect(aislePieces(aisle('x', [[0, 0], [10000, 0], [10000 - 5000, 5000 * Math.sqrt(3)]]))[2]).toHaveLength(4)
  })
})

describe('設備と通路', () => {
  const straight = aisle('aisle-1', [[0, 0], [10000, 0]]) // 帯は y = -500 〜 500

  it('帯の縁に接するだけなら重ならない。入り込めば重なり、その部分を返す', () => {
    expect(findOverlaps(scene([eq('a', 2000, 500, 1000, 1000)], [straight]))).toEqual([])
    const o = findOverlaps(scene([eq('a', 2000, 300, 1000, 1000)], [straight]))
    expect(o).toHaveLength(1)
    const hit = o[0]!
    if (hit.kind !== 'aisle') throw new Error('通路との重なりのはず')
    expect(hit).toMatchObject({ equipment: 'a', aisle: 'aisle-1' })
    expect(area(hit.regions[0]!)).toBeCloseTo(1000 * 200)
  })

  it('端は butt: 中心線の終わりより先には帯が無い', () => {
    expect(findOverlaps(scene([eq('a', 10000, -200, 500, 400)], [straight]))).toEqual([])
    expect(findOverlaps(scene([eq('a', 9990, -200, 500, 400)], [straight]))).toHaveLength(1)
  })

  it('角の外側の埋めにかかる設備を見落とさない', () => {
    const ell = aisle('aisle-1', [[0, 0], [10000, 0], [10000, 5000]])
    // 角の外側（x 10000〜10500、y -500〜0）の右上の隅にだけかかる。線分の長方形にはかからない
    expect(findOverlaps(scene([eq('a', 10400, -900, 1000, 500)], [ell]))).toHaveLength(1)
    // 埋めの外側に接するだけ
    expect(findOverlaps(scene([eq('a', 10500, -900, 1000, 500)], [ell]))).toEqual([])
  })

  it('斜めの通路は線分の向きで判定する（外接の長方形にはかかるが帯にはかからない設備）', () => {
    const diag = aisle('aisle-1', [[0, 0], [10000, 10000]])
    expect(findOverlaps(scene([eq('a', 7000, 1000, 1000, 1000)], [diag]))).toEqual([])
    expect(findOverlaps(scene([eq('a', 4500, 4500, 1000, 1000)], [diag]))).toHaveLength(1)
  })

  it('通路どうしの交差は重なりとしない', () => {
    const cross = aisle('aisle-2', [[5000, -5000], [5000, 5000]])
    expect(findOverlaps(scene([], [straight, cross]))).toEqual([])
  })
})

describe('切り取りと分離軸', () => {
  it('長方形の中の多角形はそのまま、外は空', () => {
    const r = { x: 0, y: 0, width: 100, height: 100 }
    const tri = [{ x: 10, y: 10 }, { x: 50, y: 10 }, { x: 10, y: 50 }]
    expect(clipToRect(tri, r)).toEqual(tri)
    expect(clipToRect(tri.map((p) => ({ x: p.x + 200, y: p.y })), r)).toEqual([])
  })

  it('斜めの帯が角だけをかすめる', () => {
    const r = { x: 0, y: 0, width: 100, height: 100 }
    // x + y = 190 から 210 の帯は (100, 100) の角だけにかかる
    const band = [{ x: 190, y: 0 }, { x: 210, y: 0 }, { x: 0, y: 210 }, { x: 0, y: 190 }]
    expect(convexOverlapsRect(band, r)).toBe(true)
    expect(area(clipToRect(band, r))).toBeCloseTo(50)
    const away = band.map((p) => ({ x: p.x + 10, y: p.y + 10 }))
    // x + y = 210 の線が (100, 100) を通らない側
    expect(convexOverlapsRect(away, r)).toBe(false)
  })
})

describe('余白への入り込み', () => {
  // 左上 (0, 0)、4000 × 2000 の設備に、上 500・右 1000・下 0・左 0 の余白
  const owner = (rotation: Rotation = 0): Equipment => ({ ...eq('o', 0, 0, 4000, 2000, rotation), clearance: { top: 500, right: 1000, bottom: 0, left: 0 } })

  it('余白を辺ごとの長方形に分け、幅 0 の辺は出さない', () => {
    expect(clearanceZone(owner())).toEqual([
      { x: 0, y: -500, width: 5000, height: 500 },
      { x: 4000, y: 0, width: 1000, height: 2000 },
    ])
  })

  it('他の設備の本体が余白に入ると、入った部分を返す。本体どうしの重なりにはしない', () => {
    const o = findOverlaps(scene([owner(), eq('b', 4500, 1000, 1000, 1000)]))
    expect(o).toEqual([{ kind: 'clearance', owner: 'o', equipment: 'b', regions: [{ x: 4500, y: 1000, width: 500, height: 1000 }] }])
    expect(overlappingEquipment(o).size).toBe(0)
    expect([...clearanceEquipment(o)].sort()).toEqual(['b', 'o'])
  })

  it('余白の外側の縁に接するだけなら入っていない。余白の無い辺に接するのも同じ', () => {
    expect(findOverlaps(scene([owner(), eq('b', 5000, 0, 1000, 1000)]))).toEqual([])
    expect(findOverlaps(scene([owner(), eq('b', 0, 2000, 1000, 1000)]))).toEqual([])
    expect(findOverlaps(scene([owner(), eq('b', -1000, 0, 1000, 1000)]))).toEqual([])
  })

  it('余白は設備と一緒に回る', () => {
    // 90 度: 外接 (0, 0)〜(2000, 4000)。上の余白 500 が右へ、右の余白 1000 が下へ
    const o = owner(90)
    expect(findOverlaps(scene([o, eq('b', 2100, 0, 500, 500)]))).toHaveLength(1)
    expect(findOverlaps(scene([o, eq('b', 500, 4200, 500, 500)]))).toHaveLength(1)
    expect(findOverlaps(scene([o, eq('b', 500, -600, 500, 500)]))).toEqual([])
  })

  it('余白どうしの重なりと、余白と通路の重なりは示さない', () => {
    const other = { ...eq('p', 5500, 0, 1000, 1000), clearance: { top: 0, right: 0, bottom: 0, left: 1000 } }
    expect(findOverlaps(scene([owner(), other]))).toEqual([])
    expect(findOverlaps(scene([owner()], [aisle('aisle-1', [[0, -300], [6000, -300]], { width: 200 })]))).toEqual([])
  })

  it('両方が互いの余白に入っていれば 2 件', () => {
    const a = { ...eq('a', 0, 0, 1000, 1000), clearance: { top: 0, right: 600, bottom: 0, left: 0 } }
    const b = { ...eq('b', 1500, 0, 1000, 1000), clearance: { top: 0, right: 0, bottom: 0, left: 600 } }
    expect(findOverlaps(scene([a, b])).map((o) => o.kind === 'clearance' && `${o.owner}>${o.equipment}`)).toEqual(['a>b', 'b>a'])
  })
})

describe('成形機に載る取出機', () => {
  const machine = { ...eq('m', 0, 0, 10000, 2800), clearance: { top: 1000, right: 1000, bottom: 1000, left: 1000 } }
  const robot = { ...eq('r', 6000, -800, 800, 3600), kind: 'take-out-robot', clearance: { top: 500, right: 500, bottom: 500, left: 500 } }
  const other = { ...eq('x', 6000, 3000, 800, 800), kind: 'take-out-robot' }

  it('つないだ成形機と取出機は、本体の重なりも余白への入り込みも示さない（どちら向きのつなぎでも）', () => {
    expect(findOverlaps({ ...scene([machine, robot]), links: [{ from: 'm', to: 'r' }] })).toEqual([])
    expect(findOverlaps({ ...scene([machine, robot]), links: [{ from: 'r', to: 'm' }] })).toEqual([])
  })

  it('つないでいなければ示す。ほかの設備との重なりはつないでいても示す', () => {
    // 余白への入り込みは、頭上の取出機と床の成形機の組なので示さない
    expect(findOverlaps(scene([machine, robot])).map((o) => o.kind)).toEqual(['equipment'])
    const o = findOverlaps({ ...scene([machine, robot, other]), links: [{ from: 'm', to: 'r' }] })
    // other（別の取出機）は取出機の下の余白に入る。成形機の余白は床の保守の場所なので、頭上の取出機は入っても示さない
    expect(o.map((x) => x.kind === 'clearance' && `${x.owner}>${x.equipment}`)).toEqual(['r>x'])
  })

  it('成形機どうし・取出機どうしは、つないでいても示す', () => {
    const m2 = eq('m2', 5000, 0, 10000, 2800)
    expect(findOverlaps({ ...scene([eq('m', 0, 0, 10000, 2800), m2]), links: [{ from: 'm', to: 'm2' }] })).toHaveLength(1)
  })
})

describe('頭上の取出機と床の設備', () => {
  const around = (mm: number) => ({ top: mm, right: mm, bottom: mm, left: mm })
  const machine = { ...eq('m', 0, 0, 10000, 2800), clearance: around(1000) }
  // 梁が成形機を横切り、下の余白を越えて型抜き機の上まで張り出す
  const robot = { ...eq('r', 6000, -800, 800, 6000), kind: 'take-out-robot', clearance: around(500) }
  const degating = { ...eq('d', 5800, 3800, 1500, 1500), kind: 'degating-machine', clearance: around(500) }
  const units = { links: [{ from: 'm', to: 'r' }, { from: 'r', to: 'd' }] }

  it('同じユニットの後工程とは、本体が重なっても示さない', () => {
    expect(findOverlaps({ ...scene([machine, robot, degating]), ...units })).toEqual([])
  })

  it('ほかのユニットの床の設備とは本体の重なりを示し、余白への入り込みは示さない', () => {
    const m2 = { ...eq('m2', 0, 7000, 10000, 2800), clearance: around(1000) }
    const d2 = { ...eq('d2', 6200, 4800, 600, 600), kind: 'degating-machine', clearance: around(500) }
    const o = findOverlaps({ ...scene([machine, robot, degating, m2, d2]), links: [...units.links, { from: 'm2', to: 'd2' }] })
    expect(o.filter((x) => x.kind === 'equipment').map((x) => x.kind === 'equipment' && `${x.a}+${x.b}`)).toEqual(['r+d2', 'd+d2'])
    // d2 は型抜き機 d の余白に入る（床どうし）。取出機の余白への入り込みは示さない
    expect(o.filter((x) => x.kind === 'clearance').map((x) => x.kind === 'clearance' && `${x.owner}>${x.equipment}`)).toEqual(['d>d2', 'd2>d'])
  })

  it('同じユニットの取出機どうしは示す', () => {
    const r2 = { ...robot, id: 'r2', name: 'r2', x: robot.x + 400 }
    const o = findOverlaps({ ...scene([machine, robot, r2]), links: [{ from: 'm', to: 'r' }, { from: 'm', to: 'r2' }] })
    expect(o.filter((x) => x.kind === 'equipment').map((x) => x.kind === 'equipment' && `${x.a}+${x.b}`)).toEqual(['r+r2'])
  })

  it('通路とは今までどおり示す', () => {
    const o = findOverlaps({ ...scene([machine, robot, degating], [aisle('a', [[5000, 4200], [9000, 4200]])]), ...units })
    expect(o.map((x) => x.kind === 'aisle' && x.equipment)).toEqual(['r', 'd'])
  })
})
