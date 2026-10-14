import { describe, expect, it } from 'vitest'
import { createEmptyScene, type Equipment, type Scene } from './scene'
import {
  activePlan,
  applyPlanCommand,
  createPlanSet,
  nextPlanIds,
  nextPlanName,
  uniquePlanName,
  withActiveScene,
  type PlanCommand,
  type PlanSet,
} from './plans'
import { PLAN_FILE_FORMAT, parsePlanFile, serializePlanSet, serializeScene } from './sceneFile'

function eq(id: string, over: Partial<Equipment> = {}): Equipment {
  return { id, kind: 'molding-machine', name: id, x: 1000, y: 2000, width: 3000, depth: 1500, rotation: 0, color: '#888', clearance: { top: 0, right: 0, bottom: 0, left: 0 }, ...over }
}

const withEq = (...ids: string[]): Scene => ({ ...createEmptyScene(), equipment: ids.map((id) => eq(id)) })

function ok(set: PlanSet, cmd: PlanCommand): PlanSet {
  const r = applyPlanCommand(set, cmd)
  if (!r.ok) throw new Error(r.error)
  return r.set
}

function err(set: PlanSet, cmd: PlanCommand): string {
  const r = applyPlanCommand(set, cmd)
  if (r.ok) throw new Error('失敗するはずが通った')
  return r.error
}

// 案 1（設備 a）・案 2（空）・案 3（設備 b, c）
function three(): PlanSet {
  let s = createPlanSet(withEq('a'))
  s = ok(s, { type: 'addPlan', id: 'plan-2' })
  s = ok(s, { type: 'addPlan', id: 'plan-3', scene: withEq('b', 'c') })
  return s
}

describe('案の束', () => {
  it('最初は空のシーンの「案 1」が 1 つ', () => {
    const s = createPlanSet()
    expect(s.plans.map((p) => p.name)).toEqual(['案 1'])
    expect(activePlan(s).scene).toEqual(createEmptyScene())
  })

  it('次の id と名前は使われているものの最大 + 1', () => {
    const s = three()
    expect(nextPlanIds(s, 2)).toEqual(['plan-4', 'plan-5'])
    expect(nextPlanName(ok(s, { type: 'renamePlan', id: 'plan-2', name: '案 7' }))).toBe('案 8')
    expect(uniquePlanName(['A', 'A 2'], 'A')).toBe('A 3')
    expect(uniquePlanName(['A'], 'B')).toBe('B')
  })

  it('開いている案のシーンを書き戻す。同じシーンなら束も同じもの', () => {
    const s = three()
    const t = withActiveScene(s, withEq('z'))
    expect(activePlan(t).scene.equipment.map((e) => e.id)).toEqual(['z'])
    expect(t.plans[0]!.scene).toBe(s.plans[0]!.scene)
    expect(withActiveScene(t, activePlan(t).scene)).toBe(t)
  })
})

describe('案のコマンド', () => {
  it('足すと後ろに並び、その案を開く。名前は「案 n」', () => {
    const s = three()
    expect(s.plans.map((p) => p.name)).toEqual(['案 1', '案 2', '案 3'])
    expect(s.active).toBe('plan-3')
    expect(activePlan(s).scene.equipment).toHaveLength(2)
    expect(err(s, { type: 'addPlan', id: 'plan-1' })).toMatch('重複')
    expect(err(s, { type: 'addPlan', id: 'plan-9', name: ' 案 2 ' })).toMatch('同じ名前')
    expect(err(s, { type: 'addPlan', id: 'plan-9', name: '  ' })).toMatch('空')
  })

  it('複製は元の案のすぐ後に「の写し」で足し、写しを開く。シーンは同じ中身', () => {
    let s = ok(three(), { type: 'duplicatePlan', source: 'plan-1', id: 'plan-4' })
    expect(s.plans.map((p) => p.name)).toEqual(['案 1', '案 1 の写し', '案 2', '案 3'])
    expect(s.active).toBe('plan-4')
    expect(activePlan(s).scene).toEqual(withEq('a'))
    s = ok(s, { type: 'duplicatePlan', source: 'plan-1', id: 'plan-5' })
    expect(s.plans[1]!.name).toBe('案 1 の写し 2')
    expect(err(s, { type: 'duplicatePlan', source: 'plan-9', id: 'plan-6' })).toMatch('見つかりません')
  })

  it('名前を変える。前後の空白を落とし、空と他の案と同じ名前は断る', () => {
    const s = ok(three(), { type: 'renamePlan', id: 'plan-2', name: ' 2 列案 ' })
    expect(s.plans[1]!.name).toBe('2 列案')
    expect(ok(s, { type: 'renamePlan', id: 'plan-2', name: '2 列案' })).toBe(s)
    expect(err(s, { type: 'renamePlan', id: 'plan-2', name: '' })).toMatch('空')
    expect(err(s, { type: 'renamePlan', id: 'plan-2', name: '案 1' })).toMatch('同じ名前')
  })

  it('消す。開いている案を消すとすぐ前を開く。最後の 1 つは消せない', () => {
    let s = three() // plan-3 を開いている
    s = ok(s, { type: 'removePlan', id: 'plan-3' })
    expect(s.active).toBe('plan-2')
    s = ok(s, { type: 'switchPlan', id: 'plan-1' })
    s = ok(s, { type: 'removePlan', id: 'plan-1' })
    expect(s.active).toBe('plan-2')
    expect(err(s, { type: 'removePlan', id: 'plan-2' })).toMatch('最後')
    // 開いていない案を消しても開いている案は変わらない
    const t = ok(ok(three(), { type: 'switchPlan', id: 'plan-1' }), { type: 'removePlan', id: 'plan-2' })
    expect(t.active).toBe('plan-1')
  })

  it('切り替える。無い案は断る', () => {
    const s = ok(three(), { type: 'switchPlan', id: 'plan-1' })
    expect(activePlan(s).name).toBe('案 1')
    expect(err(s, { type: 'switchPlan', id: 'x' })).toMatch('見つかりません')
  })

  it('ファイルの案を後ろに足す。id は振り直し、名前は重なれば番号を付け、最初の案を開く', () => {
    const s = ok(three(), {
      type: 'importPlans',
      plans: [
        { id: 'plan-1', name: '案 1', scene: withEq('x') },
        { id: 'plan-2', name: '別案', scene: createEmptyScene() },
      ],
    })
    expect(s.plans.map((p) => `${p.id}:${p.name}`)).toEqual(['plan-1:案 1', 'plan-2:案 2', 'plan-3:案 3', 'plan-4:案 1 2', 'plan-5:別案'])
    expect(s.active).toBe('plan-4')
    expect(err(s, { type: 'importPlans', plans: [] })).toMatch('ありません')
  })

  it('失敗しても元の束を変えない', () => {
    const s = three()
    const before = JSON.stringify(s)
    err(s, { type: 'removePlan', id: 'x' })
    err(s, { type: 'renamePlan', id: 'plan-1', name: '案 2' })
    expect(JSON.stringify(s)).toBe(before)
  })
})

describe('案の束のファイル', () => {
  it('書き出して読み直すと同じ案の束に戻る（名前・並び・開いている案・シーン）', () => {
    const s = ok(three(), { type: 'switchPlan', id: 'plan-2' })
    const r = parsePlanFile(serializePlanSet(s), 'x')
    expect(r).toEqual({ ok: true, plans: s.plans, active: 'plan-2' })
  })

  it('シーン 1 つだけのファイルは、渡した名前の案 1 つとして読む', () => {
    const r = parsePlanFile(serializeScene(withEq('a')), 'layout-old')
    expect(r).toEqual({ ok: true, plans: [{ id: 'plan-1', name: 'layout-old', scene: withEq('a'), layout: { id: 'L01', signature: 'molding-machine/H:0' } }], active: 'plan-1' })
    // 古い版のシーンも、シーンのファイルと同じ変換で読む
    const old = parsePlanFile(JSON.stringify({ version: 1, background: null, equipment: [] }), 'v1')
    expect(old.ok && old.plans[0]!.scene).toEqual(createEmptyScene())
  })

  it('開いていた案が無ければ先頭を開く', () => {
    const data = JSON.parse(serializePlanSet(three()))
    data.active = 'nope'
    const r = parsePlanFile(JSON.stringify(data), 'x')
    expect(r.ok && r.active).toBe('plan-1')
  })

  it('不正なものは理由つきで断る', () => {
    const file = (over: Record<string, unknown>) => JSON.stringify({ format: PLAN_FILE_FORMAT, version: 1, active: 'p', ...over })
    const scene = JSON.parse(serializeScene(createEmptyScene()))
    const error = (text: string) => {
      const r = parsePlanFile(text, 'x')
      return r.ok ? '' : r.error
    }
    expect(error('{')).toMatch('JSON')
    expect(error(file({ version: 9, plans: [] }))).toMatch('新しい版')
    expect(error(file({ plans: [] }))).toMatch('plans')
    expect(error(file({ plans: [{ id: 'p', name: 'A', scene }, { id: 'p', name: 'B', scene }] }))).toMatch('重複')
    expect(error(file({ plans: [{ id: 'p', name: 'A', scene }, { id: 'q', name: 'A', scene }] }))).toMatch('同じ名前')
    expect(error(file({ plans: [{ id: 'p', name: ' ', scene }] }))).toMatch('名前')
    expect(error(file({ plans: [{ id: 'p', name: 'A', scene: { ...scene, equipment: [eq('a', { width: 0 })] } }] }))).toMatch('案「A」')
  })
})
