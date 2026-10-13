import { describe, expect, it } from 'vitest'
import { applyCommand, type Command } from './commands'
import { chainByProcess, checkLink, linkHitTest, linkSegment, neighbors, reaches } from './flow'
import { createEmptyScene, type Equipment, type Scene } from './scene'
import { parseScene, serializeScene } from './sceneFile'

function eq(id: string, kind: string, over: Partial<Equipment> = {}): Equipment {
  return { id, kind, name: id, x: 0, y: 0, width: 1000, depth: 1000, rotation: 0, color: '#888', clearance: { top: 0, right: 0, bottom: 0, left: 0 }, ...over }
}

// 成形機 m → 取出機 t → 重量計 w を左から右へ 3000 mm おきに並べる（つなぎは無し）
function line(): Scene {
  return {
    ...createEmptyScene(),
    equipment: [
      eq('m', 'molding-machine', { width: 2000 }),
      eq('t', 'take-out-robot', { x: 3000 }),
      eq('w', 'weighing-scale', { x: 6000 }),
      eq('s1', 'cart-stocker', { x: 9000 }),
      eq('s2', 'cart-stocker', { x: 9000, y: 3000 }),
    ],
  }
}

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

describe('link と unlink', () => {
  it('つなぎを足し・外す。元のシーンは変えない', () => {
    const before = line()
    const after = ok(before, { type: 'link', links: [{ from: 'm', to: 't' }, { from: 't', to: 'w' }] })
    expect(after.links).toEqual([{ from: 'm', to: 't' }, { from: 't', to: 'w' }])
    expect(before.links).toEqual([])
    expect(ok(after, { type: 'unlink', links: [{ from: 'm', to: 't' }] }).links).toEqual([{ from: 't', to: 'w' }])
  })

  it('1 台から 2 台へ（予備のストッカーへの枝）、2 台から 1 台へ（列の共有）もつなげる', () => {
    let s = ok(line(), { type: 'link', links: [{ from: 'w', to: 's1' }, { from: 'w', to: 's2' }] })
    s = ok({ ...s, equipment: [...s.equipment, eq('m2', 'molding-machine', { y: 3000 })] }, { type: 'link', links: [{ from: 'm', to: 't' }, { from: 'm2', to: 't' }] })
    expect(neighbors(s, 'w')).toEqual({ prev: [], next: ['s1', 's2'] })
    expect(neighbors(s, 't')).toEqual({ prev: ['m', 'm2'], next: [] })
  })

  it('自分自身・無い設備・同じつなぎ・輪を断る。1 本でも断られたらどれも足さない', () => {
    const s = ok(line(), { type: 'link', links: [{ from: 'm', to: 't' }, { from: 't', to: 'w' }] })
    expect(err(s, { type: 'link', links: [{ from: 'm', to: 'm' }] })).toMatch('自分自身')
    expect(err(s, { type: 'link', links: [{ from: 'm', to: 'x' }] })).toMatch('見つかりません')
    expect(err(s, { type: 'link', links: [{ from: 'm', to: 't' }] })).toMatch('もうつないで')
    expect(err(s, { type: 'link', links: [{ from: 'w', to: 'm' }] })).toMatch('輪')
    expect(err(s, { type: 'link', links: [{ from: 'w', to: 's1' }, { from: 's1', to: 'm' }] })).toMatch('輪')
    expect(err(s, { type: 'link', links: [] })).toMatch('ありません')
    expect(err(s, { type: 'unlink', links: [{ from: 'w', to: 's1' }] })).toMatch('見つかりません')
  })

  it('設備を消すと、その設備のつなぎも消える', () => {
    const s = ok(line(), { type: 'link', links: [{ from: 'm', to: 't' }, { from: 't', to: 'w' }, { from: 'w', to: 's1' }] })
    expect(ok(s, { type: 'remove', ids: ['t'] }).links).toEqual([{ from: 'w', to: 's1' }])
  })

  it('複製は、写した設備どうしのつなぎを写しにも張る（写さなかった設備とのつなぎは張らない）', () => {
    const s = ok(line(), { type: 'link', links: [{ from: 'm', to: 't' }, { from: 't', to: 'w' }] })
    const d = ok(s, { type: 'duplicate', ids: ['m', 't'], newIds: ['m-c', 't-c'], dx: 0, dy: 5000 })
    expect(d.links).toEqual([{ from: 'm', to: 't' }, { from: 't', to: 'w' }, { from: 'm-c', to: 't-c' }])
  })

  it('消した設備を同じ id で足し直しても、つなぎは戻らない（つなぎは設備と別に持つ）', () => {
    const s = ok(line(), { type: 'link', links: [{ from: 'm', to: 't' }] })
    const removed = ok(s, { type: 'remove', ids: ['m'] })
    expect(ok(removed, { type: 'add', equipment: eq('m', 'molding-machine') }).links).toEqual([])
  })
})

describe('ファイル', () => {
  it('つなぎを書いて読み直すと同じに戻る', () => {
    const s = ok(line(), { type: 'link', links: [{ from: 'm', to: 't' }, { from: 't', to: 'w' }] })
    const r = parseScene(serializeScene(s))
    expect(r.ok && r.scene).toEqual(s)
  })

  it('版 4 のファイルはつなぎ無しで読む', () => {
    const v4 = JSON.stringify({ version: 4, background: null, site: null, equipment: [eq('m', 'molding-machine')], aisles: [] })
    const r = parseScene(v4)
    expect(r.ok && r.scene.links).toEqual([])
  })

  it('不正なつなぎ（無い設備・輪）は理由つきで断る', () => {
    const base = { version: 5, background: null, site: null, equipment: [eq('a', 'molding-machine'), eq('b', 'take-out-robot')], aisles: [] }
    const bad = (links: unknown) => {
      const r = parseScene(JSON.stringify({ ...base, links }))
      return r.ok ? '' : r.error
    }
    expect(bad([{ from: 'a', to: 'z' }])).toMatch('見つかりません')
    expect(bad([{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }])).toMatch('輪')
    expect(bad(undefined)).toMatch('links')
  })
})

describe('chainByProcess', () => {
  it('選んだ順にかかわらず、工程の順に隣どうしをつなぐ', () => {
    const r = chainByProcess(line(), ['s1', 'w', 'm', 't'])
    expect(r).toEqual({ ok: true, links: [{ from: 'm', to: 't' }, { from: 't', to: 'w' }, { from: 'w', to: 's1' }] })
  })

  it('もうつないである組は除く。全部つないであれば断る', () => {
    const s = ok(line(), { type: 'link', links: [{ from: 'm', to: 't' }] })
    expect(chainByProcess(s, ['m', 't', 'w'])).toEqual({ ok: true, links: [{ from: 't', to: 'w' }] })
    const all = ok(s, { type: 'link', links: [{ from: 't', to: 'w' }] })
    expect(chainByProcess(all, ['m', 't', 'w'])).toMatchObject({ ok: false, error: expect.stringMatching('もう') })
  })

  it('1 台だけ・同じ種類が 2 台・ひな形に無い種類は断る', () => {
    const s = line()
    expect(chainByProcess(s, ['m'])).toMatchObject({ ok: false })
    expect(chainByProcess(s, ['w', 's1', 's2'])).toMatchObject({ ok: false, error: expect.stringMatching('同じ種類') })
    const odd = { ...s, equipment: [...s.equipment, eq('x', 'conveyor')] }
    expect(chainByProcess(odd, ['m', 'x'])).toMatchObject({ ok: false, error: expect.stringMatching('順が決まっていない') })
  })
})

describe('reaches と checkLink', () => {
  it('矢印をたどって行けるか', () => {
    const links = [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }]
    expect(reaches(links, 'a', 'c')).toBe(true)
    expect(reaches(links, 'c', 'a')).toBe(false)
  })

  it('問題の無いつなぎは null', () => {
    expect(checkLink(line(), { from: 'm', to: 't' })).toBeNull()
  })
})

describe('linkSegment と linkHitTest', () => {
  it('2 台の縁から縁へ引く（中心どうしの線のうち外形の外の部分）', () => {
    const s = line()
    // m は幅 2000（x: -1000..1000）、t は幅 1000（x: 2500..3500）
    expect(linkSegment(s.equipment[0]!, s.equipment[1]!)).toEqual([{ x: 1000, y: 0 }, { x: 2500, y: 0 }])
    // 斜め: w (6000, 0) → s2 (9000, 3000)。それぞれ角を通って出入りする
    const [p, q] = linkSegment(s.equipment[2]!, s.equipment[4]!)
    expect(p).toEqual({ x: 6500, y: 500 })
    expect(q).toEqual({ x: 8500, y: 2500 })
  })

  it('重なっていて外に出る部分が無ければ、中心どうしを結ぶ', () => {
    const a = eq('a', 'molding-machine')
    const b = eq('b', 'take-out-robot', { x: 500 })
    expect(linkSegment(a, b)).toEqual([{ x: 0, y: 0 }, { x: 500, y: 0 }])
  })

  it('線から許容の距離以内なら当たる', () => {
    const s = ok(line(), { type: 'link', links: [{ from: 'm', to: 't' }] })
    expect(linkHitTest(s, { x: 1800, y: 40 }, 50)).toEqual({ from: 'm', to: 't' })
    expect(linkHitTest(s, { x: 1800, y: 80 }, 50)).toBeNull()
  })
})
