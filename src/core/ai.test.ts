import { describe, expect, it } from 'vitest'
import { AI_LENGTH_LIMIT, MAX_AI_COMMANDS, parseAiReply, planAiCommands } from './ai'
import { stubReply } from './aiStub'
import { applyCommand } from './commands'
import { createEmptyScene, footprint, type Scene } from './scene'
import { findTemplate, equipmentFromTemplate } from './templates'

function withMachines(n: number): Scene {
  let s = createEmptyScene()
  const t = findTemplate('molding-machine')!
  for (let i = 1; i <= n; i++) {
    const r = applyCommand(s, { type: 'add', equipment: equipmentFromTemplate(t, { id: `eq-${i}`, name: `成形機 ${i}`, center: { x: i * 10000, y: 5000 } }) })
    if (!r.ok) throw new Error(r.error)
    s = r.scene
  }
  return s
}

function plan(s: Scene, commands: unknown[]) {
  return planAiCommands(s, commands)
}

describe('parseAiReply', () => {
  it('JSON だけの応答を読む', () => {
    const r = parseAiReply('{"message":"並べます","commands":[{"type":"remove","ids":["eq-1"]}]}')
    expect(r).toEqual({ ok: true, reply: { message: '並べます', commands: [{ type: 'remove', ids: ['eq-1'] }] } })
  })

  it('前後に文がある応答や ```json のかこみからも取り出す', () => {
    const r = parseAiReply('こうします。\n```json\n{"commands":[]}\n```\nどうぞ。')
    expect(r).toEqual({ ok: true, reply: { message: '', commands: [] } })
    const r2 = parseAiReply('答え: {"message":"はい"} です')
    expect(r2).toEqual({ ok: true, reply: { message: 'はい', commands: [] } })
  })

  it('配列だけの応答は commands とみなす', () => {
    expect(parseAiReply('[{"type":"remove","ids":["a"]}]')).toMatchObject({ ok: true, reply: { commands: [{ type: 'remove' }] } })
  })

  it('読めない・形が違う・多すぎる応答は理由つきで断る', () => {
    expect(parseAiReply('')).toEqual({ ok: false, error: '応答が空です' })
    expect(parseAiReply('はい、並べました')).toMatchObject({ ok: false, error: expect.stringContaining('JSON') })
    expect(parseAiReply('{"commands":{}}')).toMatchObject({ ok: false, error: expect.stringContaining('配列') })
    expect(parseAiReply('{"foo":1}')).toMatchObject({ ok: false, error: expect.stringContaining('message も commands も') })
    const many = JSON.stringify({ commands: Array.from({ length: MAX_AI_COMMANDS + 1 }, () => ({ type: 'remove', ids: ['a'] })) })
    expect(parseAiReply(many)).toMatchObject({ ok: false, error: expect.stringContaining('多すぎます') })
  })
})

describe('planAiCommands', () => {
  it('place はひな形から置き、id と名前を続きで振る。続く指示はその id を使える', () => {
    const s = withMachines(2)
    const r = plan(s, [
      { type: 'place', kind: 'molding-machine', x: 30000, y: 5000 },
      { type: 'place', kind: 'take-out-robot', x: 30000, y: 8000, rotation: 90 },
      { type: 'link', links: [{ from: 'eq-3', to: 'eq-4' }] },
    ])
    if (!r.ok) throw new Error(r.error)
    expect(r.scene.equipment.slice(2).map((e) => [e.id, e.name, e.width, e.rotation])).toEqual([
      ['eq-3', '成形機 3', 10000, 0],
      ['eq-4', '取出機 1', 800, 90],
    ])
    expect(r.scene.links).toEqual([{ from: 'eq-3', to: 'eq-4' }])
    expect(r.steps.map((x) => x.text)).toEqual([
      '成形機 3 を置く（中心 x 30,000 mm・y 5,000 mm、10,000 mm × 2,800 mm、回転 0°）',
      '取出機 1 を置く（中心 x 30,000 mm・y 8,000 mm、800 mm × 3,600 mm、回転 90°）',
      'つなぐ: 成形機 3 → 取出機 1',
    ])
    // 元のシーンは変わらない
    expect(s.equipment).toHaveLength(2)
  })

  it('画面のコマンドと同じ形の指示はそのまま通し、知らない項目は落とす', () => {
    const r = plan(withMachines(1), [
      { type: 'move', ids: ['eq-1'], dx: 1000, dy: -500, extra: true },
      { type: 'rotate', ids: ['eq-1'], quarterTurns: 1 },
      { type: 'setFlow', changes: { cycleTime: 20 } },
      { type: 'addAisle', points: [{ x: 0, y: 0 }, { x: 10000, y: 0 }] },
    ])
    if (!r.ok) throw new Error(r.error)
    expect(r.steps[0]!.command).toEqual({ type: 'move', ids: ['eq-1'], dx: 1000, dy: -500 })
    expect(r.scene.equipment[0]).toMatchObject({ x: 11000, y: 4500, rotation: 90 })
    expect(r.scene.flow.cycleTime).toBe(20)
    expect(r.scene.aisles[0]).toMatchObject({ id: 'aisle-1', name: '通路 1', width: 1500, closed: false })
    expect(r.steps.map((x) => x.text).slice(1)).toEqual([
      '成形機 1 を時計回りに 90° 回す',
      '流れの再生の数値を変える: サイクル時間（秒） 20',
      '通路 1 を描く（幅 1,500 mm、頂点 2）',
    ])
  })

  it('duplicate は newIds を省ければ続きの id を振る', () => {
    const r = plan(withMachines(2), [{ type: 'duplicate', ids: ['eq-1', 'eq-2'], dx: 0, dy: 5000 }])
    if (!r.ok) throw new Error(r.error)
    expect(r.scene.equipment.map((e) => e.id)).toEqual(['eq-1', 'eq-2', 'eq-3', 'eq-4'])
  })

  it('断った指示は何番目かと理由を返し、シーンは返さない', () => {
    const s = withMachines(1)
    expect(plan(s, [{ type: 'move', ids: ['eq-1'], dx: 1, dy: 1 }, { type: 'remove', ids: ['eq-999'] }])).toEqual({
      ok: false,
      index: 1,
      error: '2 番目の指示（remove）: 設備が見つかりません: eq-999',
    })
  })

  it('AI から使えない操作・知らない操作・知らない種類を断る', () => {
    const s = withMachines(1)
    expect(plan(s, [{ type: 'setBackground', background: null }])).toMatchObject({ ok: false, error: expect.stringContaining('背景の図面は画面で扱います') })
    expect(plan(s, [{ type: 'loadScene', scene: createEmptyScene() }])).toMatchObject({ ok: false, error: expect.stringContaining('まるごと') })
    expect(plan(s, [{ type: 'add', equipment: {} }])).toMatchObject({ ok: false, error: expect.stringContaining('place を使って') })
    expect(plan(s, [{ type: 'batch', commands: [] }])).toMatchObject({ ok: false })
    expect(plan(s, [{ type: 'teleport' }])).toMatchObject({ ok: false, error: expect.stringContaining('知らない操作です: teleport') })
    expect(plan(s, [{ type: 'place', kind: 'robot-arm', x: 0, y: 0 }])).toMatchObject({ ok: false, error: expect.stringContaining('知らない設備の種類') })
  })

  it('形の違う指示は落ちずに理由つきで断る', () => {
    const s = withMachines(1)
    const bad: unknown[] = [
      'move',
      null,
      { ids: ['eq-1'] },
      { type: 'move', ids: 'eq-1', dx: 1, dy: 1 },
      { type: 'move', ids: ['eq-1'], dx: '100', dy: 0 },
      { type: 'update', ids: ['eq-1'], changes: null },
      { type: 'link', links: [{ from: 'eq-1' }] },
      { type: 'setSite', site: { points: 'abc' } },
      { type: 'setAislePoints', id: 'aisle-1', points: [null] },
      { type: 'addAisle', points: [{ x: 0, y: 0 }], width: '1500' },
      { type: 'place', kind: 'molding-machine', x: 0, y: 0, rotation: 45 },
      { type: 'place', kind: 'molding-machine', x: 0, y: 0, name: '' },
      { type: 'place', kind: 'molding-machine', x: 0, y: 0, id: 'eq-1' },
      { type: 'duplicate', ids: ['eq-1'], dx: 0, dy: 0, newIds: [1] },
    ]
    for (const c of bad) {
      const r = plan(s, [c])
      expect(r.ok, JSON.stringify(c)).toBe(false)
      if (!r.ok) expect(r.error).toMatch(/^1 番目の指示/)
    }
  })

  it('桁外れの座標や移動量は断る', () => {
    const s = withMachines(1)
    expect(plan(s, [{ type: 'place', kind: 'weighing-scale', x: AI_LENGTH_LIMIT + 1, y: 0 }])).toMatchObject({ ok: false })
    expect(plan(s, [{ type: 'move', ids: ['eq-1'], dx: 0, dy: -1e9 }])).toMatchObject({ ok: false, error: expect.stringContaining('±1000000 mm') })
    expect(plan(s, [{ type: 'addAisle', points: [{ x: 0, y: 0 }, { x: 1e7, y: 0 }] }])).toMatchObject({ ok: false })
  })

  it('当てた結果を batch で当てると、同じシーンになる', () => {
    const s = withMachines(1)
    const r = plan(s, [
      { type: 'place', kind: 'cart-stocker', x: 0, y: 0 },
      { type: 'move', ids: ['eq-2'], dx: 3000, dy: 0 },
    ])
    if (!r.ok) throw new Error(r.error)
    const b = applyCommand(s, { type: 'batch', commands: r.steps.map((x) => x.command) })
    expect(b.ok && b.scene).toEqual(r.scene)
  })
})

describe('stubReply（差し替え部品）', () => {
  const run = (req: string, s: Scene) => {
    const p = parseAiReply(stubReply(req, s))
    if (!p.ok) throw new Error(p.error)
    return { message: p.reply.message, plan: planAiCommands(s, p.reply.commands) }
  }

  it('並べる頼みは、台数と間隔を文から拾い、置いてある設備の下に横に並べる', () => {
    const s = withMachines(1)
    const { plan: r } = run('成形機を３台、2000 mm 間隔で横に並べて', s)
    if (!r.ok) throw new Error(r.error)
    const added = r.scene.equipment.slice(1).map(footprint)
    expect(added).toHaveLength(3)
    // 本体の間が 2000 mm、同じ高さ、既存の設備（下端 6000）より下
    expect(added[1]!.x - (added[0]!.x + added[0]!.width)).toBe(2000)
    expect(added[2]!.x - (added[1]!.x + added[1]!.width)).toBe(2000)
    expect(new Set(added.map((f) => f.y)).size).toBe(1)
    expect(added[0]!.y).toBeGreaterThanOrEqual(6000)
  })

  it('縦に並べる・全部を動かす・サイクルを変える頼みに答える', () => {
    const s = withMachines(2)
    const v = run('台車ストッカーを2台、500 mm 間隔で縦に並べて', s).plan
    if (!v.ok) throw new Error(v.error)
    const [a, b] = v.scene.equipment.slice(2).map(footprint)
    expect(a!.x).toBe(b!.x)
    expect(b!.y - (a!.y + a!.height)).toBe(500)
    const m = run('全部の設備を左へ 1000 mm 動かして', s).plan
    expect(m.ok && m.scene.equipment.map((e) => e.x)).toEqual([9000, 19000])
    const f = run('サイクル時間を 20 秒にして', s).plan
    expect(f.ok && f.scene.flow.cycleTime).toBe(20)
  })

  it('断られる例は、理由つきで断られる', () => {
    const s = withMachines(1)
    expect(run('eq-999 を消して', s).plan).toMatchObject({ ok: false, error: expect.stringContaining('見つかりません: eq-999') })
    expect(run('背景の図面を外して', s).plan).toMatchObject({ ok: false, error: expect.stringContaining('背景の図面は画面で扱います') })
  })

  it('知らない頼みには、指示なしで差し替え部品だと答える', () => {
    const r = run('いい感じにして', createEmptyScene())
    expect(r.message).toContain('差し替え部品')
    expect(r.plan).toMatchObject({ ok: true, steps: [] })
  })

  it('空のシーンでは (5000, 5000) から並べる', () => {
    const r = run('重量計を1台並べて', createEmptyScene()).plan
    expect(r.ok && r.scene.equipment[0]).toMatchObject({ x: 5000, y: 5000, name: '重量計 1' })
  })
})
