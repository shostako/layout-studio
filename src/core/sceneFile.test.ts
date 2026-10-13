import { describe, expect, it } from 'vitest'
import { applyCommand } from './commands'
import { createBackground } from './background'
import { SCENE_VERSION, createEmptyScene, type Equipment, type Scene } from './scene'
import { migrate, parseScene, sceneFileName, serializeScene } from './sceneFile'

function eq(id: string, over: Partial<Equipment> = {}): Equipment {
  return { id, kind: 'molding-machine', name: id, x: 1000, y: 2000, width: 3000, depth: 1500, rotation: 90, color: '#888', clearance: { top: 0, right: 0, bottom: 0, left: 0 }, ...over }
}

const sample = (): Scene => ({
  ...createEmptyScene(),
  background: { ...createBackground('data:image/png;base64,AAAA', 'plan.png', 1800, 1200), x: -100, mmPerPixel: 20, calibrated: true },
  equipment: [eq('eq-1'), eq('eq-2', { x: 8000, rotation: 0 })],
})

function parsed(text: string): Scene {
  const r = parseScene(text)
  if (!r.ok) throw new Error(r.error)
  return r.scene
}

function parseError(text: string): string {
  const r = parseScene(text)
  if (r.ok) throw new Error('失敗するはずが通った')
  return r.error
}

describe('serializeScene と parseScene', () => {
  it('書き出して読み直すと同じシーンに戻る（背景・設備・回転・縮尺）', () => {
    const s = sample()
    expect(parsed(serializeScene(s))).toEqual(s)
    expect(parsed(serializeScene(createEmptyScene()))).toEqual(createEmptyScene())
  })

  it('知らない項目は落とす', () => {
    const data = JSON.parse(serializeScene(sample()))
    data.extra = 1
    data.equipment[0].memo = 'x'
    data.background.foo = true
    expect(parsed(JSON.stringify(data))).toEqual(sample())
  })

  it('JSON でないもの、シーンでないものは理由つきで断る', () => {
    expect(parseError('{')).toMatch('JSON')
    expect(parseError('[]')).toMatch('ファイルではありません')
    expect(parseError('{"equipment": []}')).toMatch('版')
    expect(parseError('{"version": 1, "background": null}')).toMatch('equipment')
  })

  it('新しすぎる版は断る', () => {
    expect(parseError('{"version": 99, "background": null, "equipment": []}')).toMatch('新しい版')
  })

  it('中身の不正（寸法・回転・id の重複・型・背景）を断る', () => {
    const withEq = (...items: unknown[]) => JSON.stringify({ version: 1, background: null, equipment: items })
    expect(parseError(withEq(eq('a', { width: 0 })))).toMatch('正の数')
    expect(parseError(withEq({ ...eq('a'), width: '3000' }))).toMatch('正の数')
    expect(parseError(withEq(eq('a', { rotation: 45 as never })))).toMatch('回転')
    expect(parseError(withEq(eq('a'), eq('a')))).toMatch('重複')
    expect(parseError(withEq({ ...eq('a'), name: 3 }))).toMatch('文字列')
    expect(parseError(withEq(null))).toMatch('1 番目')
    const bg = JSON.stringify({ version: 1, background: { ...sample().background, mmPerPixel: -1 }, equipment: [] })
    expect(parseError(bg)).toMatch('縮尺')
  })
})

describe('migrate', () => {
  it('古い版から順に変換して今の版にする', () => {
    const steps = {
      1: (d: Record<string, unknown>) => ({ ...d, a: 1 }),
      2: (d: Record<string, unknown>) => ({ ...d, b: (d.a as number) + 1 }),
    }
    const r = migrate({ version: 1 }, steps, 3)
    expect(r).toEqual({ ok: true, data: { version: 3, a: 1, b: 2 } })
  })

  it('変換が抜けている版は断る', () => {
    const r = migrate({ version: 1 }, {}, 2)
    expect(r.ok).toBe(false)
  })
})

describe('loadScene コマンド', () => {
  it('シーンを差し替え、失敗したら元のシーンを変えない', () => {
    const before = { ...createEmptyScene(), equipment: [eq('x')] }
    const r = applyCommand(before, { type: 'loadScene', scene: sample() })
    expect(r.ok && r.scene).toEqual(sample())
    const bad = applyCommand(before, { type: 'loadScene', scene: { ...sample(), equipment: [eq('a', { depth: -1 })] } })
    expect(bad.ok).toBe(false)
    expect(before.equipment.map((e) => e.id)).toEqual(['x'])
  })
})

describe('sceneFileName', () => {
  it('日時からファイル名を作る', () => {
    expect(sceneFileName(new Date(2026, 9, 3, 9, 5))).toBe('layout-20261003-0905.json')
  })
})

describe('版 3 からの変換', () => {
  it('版 3 のファイルは、設備の余白を 0 にして読む', () => {
    const { clearance: _, ...old } = eq('a')
    const s = parsed(JSON.stringify({ version: 3, background: null, site: null, equipment: [old], aisles: [] }))
    expect(s.version).toBe(SCENE_VERSION)
    expect(s.equipment[0]!.clearance).toEqual({ top: 0, right: 0, bottom: 0, left: 0 })
  })

  it('余白は保存して読み直しても同じ', () => {
    const s = { ...createEmptyScene(), equipment: [eq('a', { clearance: { top: 100, right: 0, bottom: 2500, left: 50 } })] }
    expect(parsed(serializeScene(s))).toEqual(s)
  })
})

describe('版 7 からの変換', () => {
  it('版 7 のファイルは、AGV を 1 台として読む', () => {
    const flow = { cycleTime: 20, stockerCapacity: 60, agvSpeed: 1500, agvHandlingTime: 30 }
    const s = parsed(JSON.stringify({ version: 7, background: null, site: null, equipment: [], aisles: [], links: [], flow }))
    expect(s.version).toBe(SCENE_VERSION)
    expect(s.flow).toEqual({ ...flow, agvCount: 1 })
  })

  it('flow の形が違うファイルは、版 7 でも 8 でも断る', () => {
    for (const flow of [null, 'x', [], 3]) {
      for (const version of [7, 8]) {
        const r = parseScene(JSON.stringify({ version, background: null, site: null, equipment: [], aisles: [], links: [], flow }))
        expect(r.ok).toBe(false)
      }
    }
  })

  it('AGV の台数は保存して読み直しても同じ', () => {
    const s = { ...createEmptyScene(), flow: { ...createEmptyScene().flow, agvCount: 3 } }
    expect(parsed(serializeScene(s))).toEqual(s)
  })
})
