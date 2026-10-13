import { describe, expect, it } from 'vitest'
import { createBackground } from './background'
import { parseLiveRequest, planLiveApply, liveSnapshot, LIVE_IMAGE_PLACEHOLDER } from './live'
import { createPlanSet, type PlanSet } from './plans'
import { createEmptyScene } from './scene'
import { parsePlanFile } from './sceneFile'

const place = { type: 'place', kind: 'molding-machine', x: 10000, y: 5000 }

function twoPlans(): PlanSet {
  const set = createPlanSet()
  return { plans: [...set.plans, { id: 'plan-2', name: '案 B', scene: createEmptyScene() }], active: 'plan-2' }
}

describe('頼みを読む', () => {
  it('state と apply を読む。形が違えば id つきで断る', () => {
    expect(parseLiveRequest('{"id":1,"type":"state"}')).toEqual({ ok: true, request: { id: 1, type: 'state' } })
    expect(parseLiveRequest(JSON.stringify({ id: 2, type: 'apply', commands: [place], newPlan: ' 写し ' }))).toMatchObject({
      ok: true,
      request: { type: 'apply', newPlan: '写し' },
    })
    expect(parseLiveRequest('{"id":3,"type":"apply"}')).toMatchObject({ ok: false, id: 3 })
    expect(parseLiveRequest('{"id":4,"type":"drop"}')).toMatchObject({ ok: false, id: 4, error: expect.stringContaining('drop') })
    expect(parseLiveRequest('{')).toMatchObject({ ok: false, id: null })
  })
})

describe('画面が受けた指示', () => {
  it('開いている案なら案のコマンドは無く、batch 1 つにまとめる', () => {
    const r = planLiveApply(twoPlans(), { id: 1, type: 'apply', commands: [place, place] })
    if (!r.ok) throw new Error(r.error)
    expect(r.plan.planCommands).toEqual([])
    expect(r.plan.command).toMatchObject({ type: 'batch', commands: [{ type: 'add' }, { type: 'add' }] })
    expect(r.plan.steps).toHaveLength(2)
    expect(r.plan.plan).toEqual({ id: 'plan-2', name: '案 B' })
  })

  it('別の案は切り替えてから、newPlan は写しを作って名前を付けてから当てる', () => {
    const a = planLiveApply(twoPlans(), { id: 1, type: 'apply', commands: [place], plan: '案 1' })
    expect(a.ok && a.plan.planCommands).toEqual([{ type: 'switchPlan', id: 'plan-1' }])
    const b = planLiveApply(twoPlans(), { id: 1, type: 'apply', commands: [place], newPlan: '試し' })
    expect(b.ok && b.plan.planCommands).toEqual([
      { type: 'duplicatePlan', source: 'plan-2', id: 'plan-3' },
      { type: 'renamePlan', id: 'plan-3', name: '試し' },
    ])
    expect(b.ok && b.plan.plan).toEqual({ id: 'plan-3', name: '試し' })
  })

  it('断られる指示・使えない名前・無い案は、何もせずに理由を返す', () => {
    expect(planLiveApply(twoPlans(), { id: 1, type: 'apply', commands: [{ type: 'remove', ids: ['eq-1'] }] })).toMatchObject({ ok: false })
    expect(planLiveApply(twoPlans(), { id: 1, type: 'apply', commands: [place], newPlan: '案 1' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('同じ名前'),
    })
    expect(planLiveApply(twoPlans(), { id: 1, type: 'apply', commands: [place], plan: 'plan-9' })).toMatchObject({ ok: false })
    expect(planLiveApply(twoPlans(), { id: 1, type: 'apply', commands: [] })).toMatchObject({ ok: false })
  })

  it('送る案の束は背景の画像の中身を抜き、ファイルとして読める', () => {
    const bg = createBackground('data:image/png;base64,AAAA', 'plan.png', 1800, 1200)
    const set = createPlanSet({ ...createEmptyScene(), background: bg })
    const text = liveSnapshot(set)
    expect(text).not.toContain('AAAA')
    const f = parsePlanFile(text, 'x')
    expect(f.ok && f.plans[0]!.scene.background).toMatchObject({ src: LIVE_IMAGE_PLACEHOLDER, pixelWidth: 1800 })
    expect(set.plans[0]!.scene.background?.src).toContain('AAAA')
  })
})
