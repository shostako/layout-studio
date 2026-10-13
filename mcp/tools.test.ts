import { describe, expect, it } from 'vitest'
import { createBackground } from '../src/core/background'
import { applyCommand } from '../src/core/commands'
import { liveSnapshot, planLiveApply, type LiveAsk, type LiveResponse } from '../src/core/live'
import { applyPlanCommand, createPlanSet, type PlanSet } from '../src/core/plans'
import { createEmptyScene, type Scene } from '../src/core/scene'
import { parsePlanFile, serializePlanSet, serializeScene } from '../src/core/sceneFile'
import { handleMessage } from './protocol'
import { TOOLS, callTool, type FileIo, type Screen } from './tools'

// ファイルの代わりに Map に読み書きする
function memoryIo(files: Record<string, string>): FileIo & { files: Map<string, string>; writes: number } {
  const m = new Map(Object.entries(files))
  const io = {
    files: m,
    writes: 0,
    read: (p: string) => m.get(p) ?? null,
    write: (p: string, t: string) => {
      io.writes += 1
      m.set(p, t)
    },
  }
  return io
}

// 背景の図面つきの案 2 つ（案 1 は空、案 2 は開いている）
function twoPlans(): string {
  const bg = createBackground('data:image/png;base64,AAAA', 'plan.png', 1800, 1200)
  const s: Scene = { ...createEmptyScene(), background: bg }
  const set = createPlanSet(s)
  return serializePlanSet({ plans: [...set.plans, { id: 'plan-2', name: '案 B', scene: s }], active: 'plan-2' })
}

const place3 = [0, 1, 2].map((i) => ({ type: 'place', kind: 'molding-machine', x: 10000, y: 5000 + i * 5000 }))

function out(r: { text: string; isError: boolean }) {
  if (r.isError) throw new Error(r.text)
  return JSON.parse(r.text)
}

describe('道具', () => {
  it('get_instructions は AI に渡す指示の書き方を返す', async () => {
    const r = (await callTool('get_instructions', {}, { io: memoryIo({}) }))
    expect(r.isError).toBe(false)
    expect(r.text).toContain('"type": "place"')
  })

  it('summarize は案の一覧と、開いていた案の要約・面積を返す。plan で名前や id を選べる', async () => {
    const io = memoryIo({ 'a.json': twoPlans() })
    const r = out((await callTool('summarize', { file: 'a.json' }, { io: io })))
    expect(r.plans.map((p: { id: string; active: boolean }) => [p.id, p.active])).toEqual([
      ['plan-1', false],
      ['plan-2', true],
    ])
    expect(r.plan).toEqual({ id: 'plan-2', name: '案 B' })
    expect(r.scene.nextIds.equipment).toBe('eq-1')
    expect(r.metrics.equipmentCount).toBe(0)
    expect(out((await callTool('summarize', { file: 'a.json', plan: '案 1' }, { io: io }))).plan.id).toBe('plan-1')
    expect((await callTool('summarize', { file: 'a.json', plan: '案 Z' }, { io: io }))).toMatchObject({ isError: true, text: expect.stringContaining('案 B') })
    expect(io.writes).toBe(0)
  })

  it('ファイルが無い・読めないときは理由を返す', async () => {
    const io = memoryIo({ 'bad.json': '{' })
    expect((await callTool('summarize', { file: 'none.json' }, { io: io }))).toMatchObject({ isError: true, text: expect.stringContaining('ファイルがありません') })
    expect((await callTool('summarize', { file: 'bad.json' }, { io: io }))).toMatchObject({ isError: true, text: expect.stringContaining('JSON') })
    expect((await callTool('summarize', {}, { io: io }))).toMatchObject({ isError: true, text: expect.stringContaining('file') })
  })

  it('check_commands は当てた後の様子を返し、ファイルは変えない', async () => {
    const io = memoryIo({ 'a.json': twoPlans() })
    const r = out((await callTool('check_commands', { file: 'a.json', commands: place3 }, { io: io })))
    expect(r.applied).toBe(false)
    expect(r.steps).toHaveLength(3)
    expect(r.metrics.before.equipmentCount).toBe(0)
    expect(r.metrics.after.equipmentCount).toBe(3)
    expect(r.nextIds.equipment).toBe('eq-4')
    expect(io.writes).toBe(0)
  })

  it('断られる指示があれば何番目かを返し、どれも当てない', async () => {
    const io = memoryIo({ 'a.json': twoPlans() })
    const r = (await callTool('apply_commands', { file: 'a.json', commands: [...place3, { type: 'remove', ids: ['eq-999'] }] }, { io: io }))
    expect(r.isError).toBe(true)
    expect(r.text).toContain('4 番目の指示（remove）')
    expect(r.text).toContain('何も変えていません')
    expect(io.writes).toBe(0)
    expect((await callTool('apply_commands', { file: 'a.json', commands: [] }, { io: io })).isError).toBe(true)
    expect((await callTool('apply_commands', { file: 'a.json', commands: [{ type: 'setBackground' }] }, { io: io })).text).toContain('背景')
  })

  it('apply_commands は開いていた案に当てて書き戻す。ほかの案と背景はそのまま', async () => {
    const io = memoryIo({ 'a.json': twoPlans() })
    const r = out((await callTool('apply_commands', { file: 'a.json', commands: place3 }, { io: io })))
    expect(r.applied).toBe(true)
    const f = parsePlanFile(io.files.get('a.json')!, 'a')
    if (!f.ok) throw new Error(f.error)
    expect(f.active).toBe('plan-2')
    expect(f.plans.map((p) => p.scene.equipment.length)).toEqual([0, 3])
    expect(f.plans[1]!.scene.background?.name).toBe('plan.png')
  })

  it('AI の応答の文字列（```json のかこみ）もそのまま commands に渡せる', async () => {
    const io = memoryIo({ 'a.json': twoPlans() })
    const text = '並べます\n```json\n' + JSON.stringify({ message: '3 台', commands: place3 }) + '\n```'
    expect(out((await callTool('check_commands', { file: 'a.json', commands: text }, { io: io }))).steps).toHaveLength(3)
  })

  it('new_plan を書くと元の案を残し、写しに当てて開く案にする', async () => {
    const io = memoryIo({ 'a.json': twoPlans() })
    const r = out((await callTool('apply_commands', { file: 'a.json', plan: 'plan-1', commands: place3, new_plan: '3 台並べ' }, { io: io })))
    expect(r.plan).toEqual({ id: 'plan-3', name: '3 台並べ' })
    const f = parsePlanFile(io.files.get('a.json')!, 'a')
    if (!f.ok) throw new Error(f.error)
    expect(f.plans.map((p) => [p.id, p.name, p.scene.equipment.length])).toEqual([
      ['plan-1', '案 1', 0],
      ['plan-3', '3 台並べ', 3],
      ['plan-2', '案 B', 0],
    ])
    expect(f.active).toBe('plan-3')
    expect((await callTool('apply_commands', { file: 'a.json', commands: place3, new_plan: '案 1' }, { io: io }))).toMatchObject({ isError: true, text: expect.stringContaining('同じ名前') })
  })

  it('シーン 1 つのファイルは、その形のまま書き戻す', async () => {
    const io = memoryIo({ 'one.json': serializeScene(createEmptyScene()) })
    out((await callTool('apply_commands', { file: 'one.json', commands: place3 }, { io: io })))
    const d = JSON.parse(io.files.get('one.json')!)
    expect(d.format).toBeUndefined()
    expect(d.equipment).toHaveLength(3)
  })
})

// 画面の代わり: 画面（src/ui/live.ts）と同じ順に、案のコマンドを通してから batch を当てる
function fakeScreen(start: PlanSet): Screen & { set: PlanSet; asks: LiveAsk[] } {
  let id = 0
  const sc = {
    set: start,
    asks: [] as LiveAsk[],
    connected: () => true,
    async request(ask: LiveAsk): Promise<LiveResponse> {
      sc.asks.push(ask)
      id += 1
      if (ask.type === 'state') return { id, ok: true, plans: liveSnapshot(sc.set) }
      const p = planLiveApply(sc.set, { ...ask, id })
      if (!p.ok) return { id, ok: false, error: p.error }
      let set = sc.set
      for (const c of p.plan.planCommands) {
        const r = applyPlanCommand(set, c)
        if (!r.ok) return { id, ok: false, error: r.error }
        set = r.set
      }
      const r = applyCommand(set.plans.find((q) => q.id === set.active)!.scene, p.plan.command)
      if (!r.ok) return { id, ok: false, error: r.error }
      sc.set = { ...set, plans: set.plans.map((q) => (q.id === set.active ? { ...q, scene: r.scene } : q)) }
      return { id, ok: true, plans: liveSnapshot(sc.set), applied: { plan: p.plan.plan, steps: p.plan.steps } }
    },
  }
  return sc
}

function twoPlanSet(): PlanSet {
  const f = parsePlanFile(twoPlans(), 'a')
  if (!f.ok) throw new Error(f.error)
  return { plans: f.plans, active: f.active }
}

describe('つながっている画面', () => {
  it('file を省くと画面の案を読む。背景の画像の中身は送らない', async () => {
    const screen = fakeScreen(twoPlanSet())
    const r = out(await callTool('summarize', {}, { io: memoryIo({}), screen }))
    expect(r.screen).toBe(true)
    expect(r.plan).toEqual({ id: 'plan-2', name: '案 B' })
    expect(liveSnapshot(screen.set)).not.toContain('base64')
  })

  it('apply_commands は画面に当てる。ファイルには書かない', async () => {
    const screen = fakeScreen(twoPlanSet())
    const io = memoryIo({})
    const r = out(await callTool('apply_commands', { commands: place3 }, { io, screen }))
    expect(r).toMatchObject({ applied: true, screen: true, plan: { id: 'plan-2' } })
    expect(r.steps).toHaveLength(3)
    expect(r.metrics.after.equipmentCount).toBe(3)
    expect(screen.set.plans.map((p) => p.scene.equipment.length)).toEqual([0, 3])
    // 背景の画像は画面の側では消えていない
    expect(screen.set.plans[1]!.scene.background?.src).toContain('base64')
    expect(io.writes).toBe(0)
  })

  it('別の案や new_plan は、画面で案を切り替え・写しを作ってから当てる', async () => {
    const screen = fakeScreen(twoPlanSet())
    const ctx = { io: memoryIo({}), screen }
    out(await callTool('apply_commands', { plan: '案 1', commands: place3.slice(0, 1) }, ctx))
    expect(screen.set.active).toBe('plan-1')
    const r = out(await callTool('apply_commands', { commands: place3, new_plan: '3 台' }, ctx))
    expect(r.plan).toEqual({ id: 'plan-3', name: '3 台' })
    expect(screen.set.plans.map((p) => [p.name, p.scene.equipment.length])).toEqual([
      ['案 1', 1],
      ['3 台', 4],
      ['案 B', 0],
    ])
  })

  it('断られる指示は画面に送らない。check_commands も画面を変えない', async () => {
    const screen = fakeScreen(twoPlanSet())
    const ctx = { io: memoryIo({}), screen }
    expect((await callTool('apply_commands', { commands: [{ type: 'remove', ids: ['eq-9'] }] }, ctx)).isError).toBe(true)
    expect(out(await callTool('check_commands', { commands: place3 }, ctx)).applied).toBe(false)
    expect(screen.asks.map((a) => a.type)).toEqual(['state', 'state'])
    expect(screen.set.plans[1]!.scene.equipment).toHaveLength(0)
  })

  it('画面がつながっていなければ、file を書くよう促す。画面の断りはそのまま返す', async () => {
    const io = memoryIo({})
    const off: Screen = { connected: () => false, request: async () => ({ id: 0, ok: false, error: 'x' }) }
    expect(await callTool('summarize', {}, { io, screen: off })).toMatchObject({ isError: true, text: expect.stringContaining('AI とつなぐ') })
    const gone: Screen = { connected: () => true, request: async () => ({ id: 0, ok: false, error: '画面がつながっていません' }) }
    expect(await callTool('summarize', {}, { io, screen: gone })).toMatchObject({ isError: true, text: '画面: 画面がつながっていません' })
  })
})

describe('MCP の受け答え', () => {
  const io = memoryIo({ 'a.json': twoPlans() })

  it('initialize は相手の版を受け、道具が使えることを返す', async () => {
    const r = (await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {} } }, { io: io }))
    expect(r).toMatchObject({ id: 1, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'layout-studio' } } })
    const r2 = (await handleMessage({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } }, { io: io }))
    expect(r2).toMatchObject({ result: { protocolVersion: '2025-06-18' } })
  })

  it('通知には返事をしない。知らない要求は断る', async () => {
    expect((await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, { io: io }))).toBeNull()
    expect((await handleMessage({ jsonrpc: '2.0', id: 3, method: 'resources/list' }, { io: io }))).toMatchObject({ error: { code: -32601 } })
    expect((await handleMessage({ id: 4, method: 'ping' }, { io: io }))).toMatchObject({ error: { code: -32600 } })
    expect((await handleMessage({ jsonrpc: '2.0', id: 5, method: 'ping' }, { io: io }))).toEqual({ jsonrpc: '2.0', id: 5, result: {} })
  })

  it('tools/list と tools/call', async () => {
    expect((await handleMessage({ jsonrpc: '2.0', id: 6, method: 'tools/list' }, { io: io }))).toMatchObject({ result: { tools: TOOLS } })
    const r = (await handleMessage({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'summarize', arguments: { file: 'a.json' } } }, { io: io }))
    expect(r).toMatchObject({ id: 7, result: { isError: false, content: [{ type: 'text' }] } })
    const bad = (await handleMessage({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'summarize', arguments: { file: 'x.json' } } }, { io: io }))
    expect(bad).toMatchObject({ result: { isError: true } })
    expect((await handleMessage({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'nope' } }, { io: io }))).toMatchObject({ error: { code: -32602 } })
  })
})
