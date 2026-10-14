import { describe, expect, it } from 'vitest'
import { describeLayout, layoutSignature, nextLayoutId } from './layout'
import { applyPlanCommand, createPlanSet, layoutChange, layoutGroups, type PlanCommand, type PlanSet } from './plans'
import { createEmptyScene, type Equipment, type Scene } from './scene'
import { parsePlanFile, serializePlanSet } from './sceneFile'

const m = (id: string, x: number, y: number, rotation: 0 | 90 = 0): Equipment => ({
  id,
  kind: 'molding-machine',
  name: id,
  x,
  y,
  width: 10000,
  depth: 2800,
  rotation,
  color: '#5b8bd9',
  clearance: { top: 1000, right: 1000, bottom: 1000, left: 1000 },
})

const scene = (eqs: Equipment[]): Scene => ({ ...createEmptyScene(), equipment: eqs })
// 横の成形機 n 台を、中心の x を揃えて上下に積んだ 1 列（3800 mm おき）
const row = (n: number, x: number, prefix = 'r') => Array.from({ length: n }, (_, i) => m(`${prefix}${i}`, x, i * 3800))

describe('layoutSignature と describeLayout', () => {
  it('横 1 列・横 2 列・縦横の混在・基準なし', () => {
    expect(layoutSignature(scene(row(7, 0)))).toBe('molding-machine:H7;V')
    expect(describeLayout(scene(row(7, 0)))).toBe('成形機 7 台（横 1 列）')
    const two = scene([...row(7, 0, 'a'), ...row(7, 17500, 'b')])
    expect(layoutSignature(two)).toBe('molding-machine:H7,7;V')
    expect(describeLayout(two)).toBe('成形機 14 台（横 2 列: 7・7）')
    const mixed = scene([...row(6, 0), ...Array.from({ length: 4 }, (_, i) => m(`v${i}`, 20000 + i * 3800, 40000, 90))])
    expect(describeLayout(mixed)).toBe('成形機 10 台（横 6・縦 4）')
    expect(layoutSignature(createEmptyScene())).toBe('')
    expect(describeLayout(createEmptyScene())).toBe('基準の設備なし')
    // 基準でない設備は数えない
    expect(layoutSignature(scene([{ ...m('x', 0, 0), kind: 'cart-stocker' }]))).toBe('')
  })

  it('列の中で少しずれても、間隔を詰めても同じ並び。列を分けるほど動かすと別の並び', () => {
    const base = layoutSignature(scene(row(3, 0)))
    const nudged = row(3, 0).map((e, i) => ({ ...e, y: e.y - i * 500, x: e.x + (i === 1 ? 900 : 0) }))
    expect(layoutSignature(scene(nudged))).toBe(base)
    const split = row(3, 0).map((e, i) => ({ ...e, x: i === 2 ? 1500 : 0 }))
    expect(layoutSignature(scene(split))).toBe('molding-machine:H2,1;V')
  })

  it('縦横が混ざるときは、横の群と縦の群の位置の関係も並びに入る', () => {
    const v = (x: number) => [m('v0', x, 20000, 90), m('v1', x + 3800, 20000, 90)]
    const right = scene([...row(3, 0), ...v(20000)])
    expect(layoutSignature(right)).toBe('molding-machine:H3;V2;LU')
    // 縦の群を横の群の左へ回すと別の並び
    expect(layoutSignature(scene([...row(3, 30000), ...v(0)]))).not.toBe(layoutSignature(right))
    // 少し寄せただけなら同じ
    expect(layoutSignature(scene([...row(3, 0), ...v(18000)]))).toBe(layoutSignature(right))
  })

  it('寸法を変えても列の分かれ方は変わらない', () => {
    const two = row(2, 0).map((e, i) => ({ ...e, x: i * 900 }))
    expect(layoutSignature(scene(two))).toBe('molding-machine:H2;V')
    expect(layoutSignature(scene(two.map((e) => ({ ...e, depth: 2000 }))))).toBe('molding-machine:H2;V')
  })

  it('列の分け方はたどる順に依らない（0・1000・2000 は 1 列）', () => {
    const chain = [m('a', 2000, 0), m('b', 0, 3800), m('c', 1000, 7600)]
    expect(layoutSignature(scene(chain))).toBe('molding-machine:H3;V')
  })

  it('番号は L01 から、使っている最大の次', () => {
    expect(nextLayoutId([])).toBe('L01')
    expect(nextLayoutId(['L01', 'L03', 'x'])).toBe('L04')
  })
})

function run(set: PlanSet, cmd: PlanCommand): PlanSet {
  const r = applyPlanCommand(set, cmd)
  if (!r.ok) throw new Error(r.error)
  return r.set
}
const lay = (set: PlanSet, id: string) => set.plans.find((p) => p.id === id)!.layout
const withScene = (set: PlanSet, id: string, s: Scene): PlanSet => ({ ...set, plans: set.plans.map((p) => (p.id === id ? { ...p, scene: s } : p)) })

describe('案のレイアウト', () => {
  it('案はレイアウトを持ち、複製は同じレイアウト、同じ並びの案は同じ番号、違う並びは次の番号', () => {
    let set = createPlanSet(scene(row(7, 0)))
    expect(set.plans[0]!.layout).toEqual({ id: 'L01', signature: 'molding-machine:H7;V' })
    set = run(set, { type: 'duplicatePlan', source: 'plan-1', id: 'plan-2' })
    expect(set.plans[1]!.layout!.id).toBe('L01')
    set = run(set, { type: 'addPlan', id: 'plan-3', scene: scene(row(7, 0)) })
    expect(set.plans[2]!.layout!.id).toBe('L01')
    set = run(set, { type: 'addPlan', id: 'plan-4', scene: scene([...row(7, 0, 'a'), ...row(7, 17500, 'b')]) })
    expect(set.plans[3]!.layout!.id).toBe('L02')
    expect(layoutGroups(set).map((g) => [g.id, g.description, g.plans.map((p) => p.id)])).toEqual([
      ['L01', '成形機 7 台（横 1 列）', ['plan-1', 'plan-2', 'plan-3']],
      ['L02', '成形機 14 台（横 2 列: 7・7）', ['plan-4']],
    ])
  })

  it('並びが変われば聞く。新しいレイアウトにする・同じ並びのレイアウトへ移す・今のままにする', () => {
    let set = createPlanSet(scene(row(7, 0)))
    set = run(set, { type: 'addPlan', id: 'plan-2', scene: scene([...row(7, 0, 'a'), ...row(7, 17500, 'b')]) })
    set = run(set, { type: 'duplicatePlan', source: 'plan-1', id: 'plan-3' })
    expect(layoutChange(set)).toBeNull()
    // plan-3 に 1 台足すと、L01 から変わる。同じ並びは無いので新しい番号
    set = withScene(set, 'plan-3', scene(row(8, 0)))
    expect(layoutChange(set)).toEqual({ from: 'L01', to: 'L03', existing: false, description: '成形機 8 台（横 1 列）' })
    const moved = run(set, { type: 'setPlanLayout', id: 'plan-3' })
    expect(lay(moved, 'plan-3')).toEqual({ id: 'L03', signature: 'molding-machine:H8;V' })
    expect(layoutChange(moved)).toBeNull()
    const kept = run(set, { type: 'confirmLayout', id: 'plan-3' })
    expect(lay(kept, 'plan-3')).toEqual({ id: 'L01', signature: 'molding-machine:H8;V' })
    // 2 列にすると、L02 と同じ並びなので L02 へ移せる
    const two = withScene(set, 'plan-3', scene([...row(7, 0, 'a'), ...row(7, 17500, 'b')]))
    expect(layoutChange(two)).toMatchObject({ to: 'L02', existing: true })
    expect(lay(run(two, { type: 'setPlanLayout', id: 'plan-3', layout: 'L02' }), 'plan-3')!.id).toBe('L02')
    expect(applyPlanCommand(two, { type: 'setPlanLayout', id: 'plan-3', layout: 'x' })).toMatchObject({ ok: false })
  })

  it('取り込む案のレイアウトは、同じ並びの番号に合わせ、無ければ次の番号にする', () => {
    let a = createPlanSet(scene(row(7, 0)))
    let b = createPlanSet(scene([...row(7, 0, 'a'), ...row(7, 17500, 'b')]))
    b = run(b, { type: 'addPlan', id: 'plan-2', scene: scene(row(7, 0)) })
    // b では 2 列が L01、1 列が L02
    expect(b.plans.map((p) => p.layout!.id)).toEqual(['L01', 'L02'])
    a = run(a, { type: 'importPlans', plans: b.plans })
    expect(a.plans.map((p) => p.layout!.id)).toEqual(['L01', 'L02', 'L01'])
  })

  it('ファイルに書いて読み直してもレイアウトは同じ。レイアウトの無い古いファイルは並びから振る', () => {
    let set = createPlanSet(scene(row(7, 0)))
    set = run(set, { type: 'addPlan', id: 'plan-2', scene: scene(row(7, 0)) })
    set = run(set, { type: 'setPlanLayout', id: 'plan-2', layout: 'L05' })
    const r = parsePlanFile(serializePlanSet(set), 'x')
    expect(r.ok && r.plans.map((p) => p.layout)).toEqual(set.plans.map((p) => p.layout))
    const old = JSON.parse(serializePlanSet(set))
    for (const p of old.plans) delete p.layout
    old.plans[1].layout = { id: 'bad' }
    const r2 = parsePlanFile(JSON.stringify(old), 'x')
    expect(r2.ok && r2.plans.map((p) => p.layout!.id)).toEqual(['L01', 'L01'])
  })
})
