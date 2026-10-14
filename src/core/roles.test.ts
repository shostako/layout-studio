// 設備の種類をデータにしたこと（版 9）: 一覧の差し替え、読み込み、古い版の変換、役割で決まる振る舞い
import { describe, expect, it } from 'vitest'
import { planAiCommands } from './ai'
import { aiInstructions, summarizeScene } from './aiPrompt'
import { stubReply } from './aiStub'
import { applyCommand, type Command } from './commands'
import { chainByProcess } from './flow'
import { createHistory, execute, undo } from './history'
import { findOverlaps } from './overlap'
import { prepareFlow } from './playback'
import { SCENE_VERSION, createEmptyScene, type Equipment, type Scene } from './scene'
import { parseScene, serializeScene } from './sceneFile'
import { INJECTION_PRESET, type EquipmentTemplate } from './templates'

function run(s: Scene, cmd: Command): Scene {
  const r = applyCommand(s, cmd)
  if (!r.ok) throw new Error(r.error)
  return r.scene
}

function eq(id: string, kind: string, x: number, y = 0, size = 1000): Equipment {
  return { id, kind, name: id, x, y, width: size, depth: size, rotation: 0, color: '#888888', clearance: { top: 0, right: 0, bottom: 0, left: 0 } }
}

const zero = { top: 0, right: 0, bottom: 0, left: 0 }
// 射出成形でない組の例: プレス機（基準）に送り装置が載り、検査台を経てパレット置き場（溜める）へ
const PRESS: EquipmentTemplate[] = [
  { kind: 'press', name: 'プレス機', width: 3000, depth: 2000, color: '#8a6fb0', clearance: zero, role: 'anchor' },
  { kind: 'feeder', name: '送り装置', width: 600, depth: 2500, color: '#4fae8a', clearance: zero, role: 'mounted', mountsOn: 'press' },
  { kind: 'inspection', name: '検査台', width: 1200, depth: 800, color: '#d9a44a', clearance: zero },
  { kind: 'pallet', name: 'パレット置き場', width: 1200, depth: 1000, color: '#7f8a99', clearance: zero, role: 'buffer' },
]

describe('setTemplates コマンド', () => {
  it('一覧を差し替え、元に戻すで戻る。置いた設備は変えない', () => {
    let s = run(createEmptyScene(), { type: 'add', equipment: eq('eq-1', 'molding-machine', 0) })
    const next = s.templates.map((t) => (t.kind === 'molding-machine' ? { ...t, width: 7000, name: '射出成形機' } : t))
    let h = createHistory(s)
    const r = execute(h, { type: 'setTemplates', templates: next })
    expect(r.ok).toBe(true)
    h = r.history
    expect(h.present.templates[0]).toMatchObject({ name: '射出成形機', width: 7000 })
    expect(h.present.equipment[0]!.width).toBe(1000)
    expect(undo(h).present.templates[0]!.width).toBe(10000)
    s = h.present
  })

  it('置いてある設備の種類は消せない。置いていない種類は消せる', () => {
    const s = run(createEmptyScene(), { type: 'add', equipment: eq('eq-1', 'molding-machine', 0) })
    const r = applyCommand(s, { type: 'setTemplates', templates: s.templates.filter((t) => t.kind !== 'molding-machine' && t.kind !== 'take-out-robot') })
    expect(r).toMatchObject({ ok: false })
    expect(!r.ok && r.error).toMatch('置いてある設備の種類は消せません: 成形機')
    const ok = run(s, { type: 'setTemplates', templates: s.templates.filter((t) => t.kind !== 'weighing-scale') })
    expect(ok.templates.map((t) => t.kind)).not.toContain('weighing-scale')
  })

  it('不正な一覧は断り、余分な項目を落として名前の前後の空白を取る', () => {
    const s = createEmptyScene([])
    expect(applyCommand(s, { type: 'setTemplates', templates: [{ ...PRESS[0]!, color: 'blue' }] })).toMatchObject({ ok: false })
    const r = run(s, { type: 'setTemplates', templates: [{ ...PRESS[0]!, name: ' プレス機 ', extra: 1 } as EquipmentTemplate] })
    expect(r.templates).toEqual([PRESS[0]])
  })
})

describe('loadScene と版 9', () => {
  it('一覧を書かないシーンは射出成形の組で読む。書けば確かめて使う', () => {
    const { templates: _t, ...rest } = createEmptyScene()
    expect(run(createEmptyScene([]), { type: 'loadScene', scene: rest as Scene }).templates).toEqual(INJECTION_PRESET)
    expect(run(createEmptyScene(), { type: 'loadScene', scene: createEmptyScene(PRESS) }).templates).toEqual(PRESS)
    const r = applyCommand(createEmptyScene(), { type: 'loadScene', scene: { ...createEmptyScene(), templates: 'x' as unknown as EquipmentTemplate[] } })
    expect(!r.ok && r.error).toMatch('templates')
  })

  it('版 8 のファイルは射出成形の組で読む', () => {
    const { templates: _t, ...v8 } = { ...createEmptyScene(), version: 8 }
    const r = parseScene(JSON.stringify({ ...v8, equipment: [eq('eq-1', 'molding-machine', 0)] }))
    expect(r.ok && r.scene.version).toBe(SCENE_VERSION)
    expect(r.ok && r.scene.templates).toEqual(INJECTION_PRESET)
  })

  it('作り込んだ一覧は保存して読み直しても同じ', () => {
    const s = { ...createEmptyScene(PRESS), equipment: [eq('eq-1', 'press', 0)] }
    const r = parseScene(serializeScene(s))
    expect(r.ok && r.scene).toEqual(s)
  })
})

describe('役割で決まる振る舞い', () => {
  it('載る: つないだ送り装置とプレス機の重なりは注意にしない。役割を外すと注意になる', () => {
    let s: Scene = { ...createEmptyScene(PRESS), equipment: [eq('p', 'press', 0, 0, 3000), eq('f', 'feeder', 500)] }
    s = run(s, { type: 'link', links: [{ from: 'p', to: 'f' }] })
    expect(findOverlaps(s)).toEqual([])
    const plain = run(s, { type: 'setTemplates', templates: PRESS.map((t) => (t.kind === 'feeder' ? { ...t, role: undefined, mountsOn: undefined } : t)) })
    expect(findOverlaps(plain).length).toBeGreaterThan(0)
    // 射出成形の成形機と取出機は、もう名前ではなく役割で載る
    const injection = run(createEmptyScene(), { type: 'setTemplates', templates: INJECTION_PRESET.map((t) => (t.kind === 'take-out-robot' ? { ...t, role: undefined, mountsOn: undefined } : t)) })
    const m: Scene = { ...injection, equipment: [eq('m', 'molding-machine', 0, 0, 3000), eq('t', 'take-out-robot', 0)], links: [{ from: 'm', to: 't' }] }
    expect(findOverlaps(m).length).toBeGreaterThan(0)
  })

  it('溜める: パレット置き場をストッカーとして再生する', () => {
    const s: Scene = {
      ...createEmptyScene(PRESS),
      equipment: [eq('p', 'press', 0), eq('i', 'inspection', 2000), eq('a', 'pallet', 4000), eq('b', 'pallet', 6000)],
      links: [
        { from: 'p', to: 'i' },
        { from: 'i', to: 'a' },
        { from: 'i', to: 'b' },
      ],
      aisles: [{ id: 'x', name: 'x', points: [{ x: 0, y: 3000 }, { x: 10000, y: 3000 }], width: 1500, closed: false }],
    }
    const m = prepareFlow(s)
    expect(m.stockers).toEqual(['a', 'b'])
    expect(m.warnings).toEqual([])
    // 台車ストッカーでも、役割が無ければストッカーにならない
    const noBuffer = createEmptyScene(INJECTION_PRESET.map((t) => (t.kind === 'cart-stocker' ? { ...t, role: undefined } : t)))
    const c = prepareFlow({ ...noBuffer, equipment: [eq('m', 'molding-machine', 0), eq('s', 'cart-stocker', 2000)], links: [{ from: 'm', to: 's' }] })
    expect(c.stockers).toEqual([])
  })

  it('工程の順は一覧の並び。並べ替えると「工程の順につなぐ」の順も変わる', () => {
    const s: Scene = { ...createEmptyScene(PRESS), equipment: [eq('a', 'pallet', 0), eq('i', 'inspection', 2000), eq('p', 'press', 4000)] }
    expect(chainByProcess(s, ['a', 'i', 'p'])).toEqual({ ok: true, links: [{ from: 'p', to: 'i' }, { from: 'i', to: 'a' }] })
    const swapped = run(s, { type: 'setTemplates', templates: [PRESS[0]!, PRESS[1]!, PRESS[3]!, PRESS[2]!] })
    expect(chainByProcess(swapped, ['a', 'i', 'p'])).toEqual({ ok: true, links: [{ from: 'p', to: 'a' }, { from: 'a', to: 'i' }] })
  })
})

describe('AI と種類の一覧', () => {
  it('place はシーンの一覧の種類を置く。setTemplates で足した種類を同じ応答の中で置ける', () => {
    const s = createEmptyScene()
    expect(planAiCommands(s, [{ type: 'place', kind: 'press', x: 0, y: 0 }])).toMatchObject({ ok: false })
    const r = planAiCommands(s, [
      { type: 'setTemplates', templates: [...s.templates, PRESS[0]] },
      { type: 'place', kind: 'press', x: 5000, y: 5000 },
    ])
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.steps[0]!.text).toBe('設備の種類の一覧を変える（足す: プレス機）')
      expect(r.scene.equipment[0]).toMatchObject({ kind: 'press', name: 'プレス機 1', width: 3000 })
    }
  })

  it('説明はシーンの一覧と役割を載せ、射出成形の決まりは成形機が基準の一覧のときだけ', () => {
    const press = aiInstructions(PRESS)
    expect(press).toContain('- feeder（送り装置）: 幅 600 × 奥行 2,500、余白 0、役割: 載る（プレス機 の上）')
    expect(press).toContain('役割: 溜める')
    expect(press).not.toContain('成形機は配置の基準')
    expect(aiInstructions()).toContain('成形機は配置の基準')
    expect(summarizeScene(createEmptyScene(PRESS)).templates).toEqual(PRESS)
  })

  it('差し替え部品はシーンの一覧の名前で頼みを読む（長い名前を先に）', () => {
    const r = JSON.parse(stubReply('パレット置き場を2台並べて', createEmptyScene(PRESS)))
    expect(r.commands.map((c: { kind: string }) => c.kind)).toEqual(['pallet', 'pallet'])
  })
})
