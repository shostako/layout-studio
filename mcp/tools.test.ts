import { describe, expect, it } from 'vitest'
import { createBackground } from '../src/core/background'
import { createPlanSet } from '../src/core/plans'
import { createEmptyScene, type Scene } from '../src/core/scene'
import { parsePlanFile, serializePlanSet, serializeScene } from '../src/core/sceneFile'
import { handleMessage } from './protocol'
import { TOOLS, callTool, type FileIo } from './tools'

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
  it('get_instructions は AI に渡す指示の書き方を返す', () => {
    const r = callTool('get_instructions', {}, memoryIo({}))
    expect(r.isError).toBe(false)
    expect(r.text).toContain('"type": "place"')
  })

  it('summarize は案の一覧と、開いていた案の要約・面積を返す。plan で名前や id を選べる', () => {
    const io = memoryIo({ 'a.json': twoPlans() })
    const r = out(callTool('summarize', { file: 'a.json' }, io))
    expect(r.plans.map((p: { id: string; active: boolean }) => [p.id, p.active])).toEqual([
      ['plan-1', false],
      ['plan-2', true],
    ])
    expect(r.plan).toEqual({ id: 'plan-2', name: '案 B' })
    expect(r.scene.nextIds.equipment).toBe('eq-1')
    expect(r.metrics.equipmentCount).toBe(0)
    expect(out(callTool('summarize', { file: 'a.json', plan: '案 1' }, io)).plan.id).toBe('plan-1')
    expect(callTool('summarize', { file: 'a.json', plan: '案 Z' }, io)).toMatchObject({ isError: true, text: expect.stringContaining('案 B') })
    expect(io.writes).toBe(0)
  })

  it('ファイルが無い・読めないときは理由を返す', () => {
    const io = memoryIo({ 'bad.json': '{' })
    expect(callTool('summarize', { file: 'none.json' }, io)).toMatchObject({ isError: true, text: expect.stringContaining('ファイルがありません') })
    expect(callTool('summarize', { file: 'bad.json' }, io)).toMatchObject({ isError: true, text: expect.stringContaining('JSON') })
    expect(callTool('summarize', {}, io)).toMatchObject({ isError: true, text: expect.stringContaining('file') })
  })

  it('check_commands は当てた後の様子を返し、ファイルは変えない', () => {
    const io = memoryIo({ 'a.json': twoPlans() })
    const r = out(callTool('check_commands', { file: 'a.json', commands: place3 }, io))
    expect(r.applied).toBe(false)
    expect(r.steps).toHaveLength(3)
    expect(r.metrics.before.equipmentCount).toBe(0)
    expect(r.metrics.after.equipmentCount).toBe(3)
    expect(r.nextIds.equipment).toBe('eq-4')
    expect(io.writes).toBe(0)
  })

  it('断られる指示があれば何番目かを返し、どれも当てない', () => {
    const io = memoryIo({ 'a.json': twoPlans() })
    const r = callTool('apply_commands', { file: 'a.json', commands: [...place3, { type: 'remove', ids: ['eq-999'] }] }, io)
    expect(r.isError).toBe(true)
    expect(r.text).toContain('4 番目の指示（remove）')
    expect(r.text).toContain('ファイルは変えていません')
    expect(io.writes).toBe(0)
    expect(callTool('apply_commands', { file: 'a.json', commands: [] }, io).isError).toBe(true)
    expect(callTool('apply_commands', { file: 'a.json', commands: [{ type: 'setBackground' }] }, io).text).toContain('背景')
  })

  it('apply_commands は開いていた案に当てて書き戻す。ほかの案と背景はそのまま', () => {
    const io = memoryIo({ 'a.json': twoPlans() })
    const r = out(callTool('apply_commands', { file: 'a.json', commands: place3 }, io))
    expect(r.applied).toBe(true)
    const f = parsePlanFile(io.files.get('a.json')!, 'a')
    if (!f.ok) throw new Error(f.error)
    expect(f.active).toBe('plan-2')
    expect(f.plans.map((p) => p.scene.equipment.length)).toEqual([0, 3])
    expect(f.plans[1]!.scene.background?.name).toBe('plan.png')
  })

  it('AI の応答の文字列（```json のかこみ）もそのまま commands に渡せる', () => {
    const io = memoryIo({ 'a.json': twoPlans() })
    const text = '並べます\n```json\n' + JSON.stringify({ message: '3 台', commands: place3 }) + '\n```'
    expect(out(callTool('check_commands', { file: 'a.json', commands: text }, io)).steps).toHaveLength(3)
  })

  it('new_plan を書くと元の案を残し、写しに当てて開く案にする', () => {
    const io = memoryIo({ 'a.json': twoPlans() })
    const r = out(callTool('apply_commands', { file: 'a.json', plan: 'plan-1', commands: place3, new_plan: '3 台並べ' }, io))
    expect(r.plan).toEqual({ id: 'plan-3', name: '3 台並べ' })
    const f = parsePlanFile(io.files.get('a.json')!, 'a')
    if (!f.ok) throw new Error(f.error)
    expect(f.plans.map((p) => [p.id, p.name, p.scene.equipment.length])).toEqual([
      ['plan-1', '案 1', 0],
      ['plan-3', '3 台並べ', 3],
      ['plan-2', '案 B', 0],
    ])
    expect(f.active).toBe('plan-3')
    expect(callTool('apply_commands', { file: 'a.json', commands: place3, new_plan: '案 1' }, io)).toMatchObject({ isError: true, text: expect.stringContaining('同じ名前') })
  })

  it('シーン 1 つのファイルは、その形のまま書き戻す', () => {
    const io = memoryIo({ 'one.json': serializeScene(createEmptyScene()) })
    out(callTool('apply_commands', { file: 'one.json', commands: place3 }, io))
    const d = JSON.parse(io.files.get('one.json')!)
    expect(d.format).toBeUndefined()
    expect(d.equipment).toHaveLength(3)
  })
})

describe('MCP の受け答え', () => {
  const io = memoryIo({ 'a.json': twoPlans() })

  it('initialize は相手の版を受け、道具が使えることを返す', () => {
    const r = handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {} } }, io)
    expect(r).toMatchObject({ id: 1, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'layout-studio' } } })
    const r2 = handleMessage({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } }, io)
    expect(r2).toMatchObject({ result: { protocolVersion: '2025-06-18' } })
  })

  it('通知には返事をしない。知らない要求は断る', () => {
    expect(handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, io)).toBeNull()
    expect(handleMessage({ jsonrpc: '2.0', id: 3, method: 'resources/list' }, io)).toMatchObject({ error: { code: -32601 } })
    expect(handleMessage({ id: 4, method: 'ping' }, io)).toMatchObject({ error: { code: -32600 } })
    expect(handleMessage({ jsonrpc: '2.0', id: 5, method: 'ping' }, io)).toEqual({ jsonrpc: '2.0', id: 5, result: {} })
  })

  it('tools/list と tools/call', () => {
    expect(handleMessage({ jsonrpc: '2.0', id: 6, method: 'tools/list' }, io)).toMatchObject({ result: { tools: TOOLS } })
    const r = handleMessage({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'summarize', arguments: { file: 'a.json' } } }, io)
    expect(r).toMatchObject({ id: 7, result: { isError: false, content: [{ type: 'text' }] } })
    const bad = handleMessage({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'summarize', arguments: { file: 'x.json' } } }, io)
    expect(bad).toMatchObject({ result: { isError: true } })
    expect(handleMessage({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'nope' } }, io)).toMatchObject({ error: { code: -32602 } })
  })
})
