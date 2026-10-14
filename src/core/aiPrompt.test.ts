import { describe, expect, it } from 'vitest'
import { parseAiReply, planAiCommands } from './ai'
import { aiInstructions, buildAiPrompt, summarizeScene } from './aiPrompt'
import { applyCommand, type Command } from './commands'
import { createEmptyScene, type Scene } from './scene'
import { rectSite } from './site'
import { INJECTION_PRESET, equipmentFromTemplate, findTemplate } from './templates'

function run(s: Scene, cmd: Command): Scene {
  const r = applyCommand(s, cmd)
  if (!r.ok) throw new Error(r.error)
  return r.scene
}

// 成形機 2 台（eq-1 は 90° 回し）、通路 1 本、つなぎ 1 本、敷地 30 m × 20 m
function sample(): Scene {
  const t = findTemplate(INJECTION_PRESET, 'molding-machine')!
  let s = createEmptyScene()
  s = run(s, { type: 'setSite', site: rectSite(0, 0, 30000, 20000) })
  s = run(s, { type: 'add', equipment: equipmentFromTemplate(t, { id: 'eq-1', name: '成形機 1', center: { x: 5000, y: 5000 }, rotation: 90 }) })
  s = run(s, { type: 'add', equipment: equipmentFromTemplate(t, { id: 'eq-2', name: '成形機 2', center: { x: 15000, y: 5000 } }) })
  s = run(s, { type: 'addAisle', aisle: { id: 'aisle-1', name: '通路 1', points: [{ x: 0, y: 15000 }, { x: 30000, y: 15000 }], width: 1500, closed: false } })
  s = run(s, { type: 'link', links: [{ from: 'eq-1', to: 'eq-2' }] })
  return s
}

describe('summarizeScene', () => {
  it('設備・通路・敷地・つなぎ・数値と次の id をまとめる', () => {
    const sum = summarizeScene(sample())
    expect(sum.unit).toBe('mm')
    expect(sum.site).toMatchObject({ bounds: { left: 0, top: 0, right: 30000, bottom: 20000 }, areaM2: 600 })
    expect(sum.equipment).toHaveLength(2)
    // 90° 回した成形機（10000 × 2800）は図面の上で 2800 × 10000
    expect(sum.equipment[0]).toMatchObject({ id: 'eq-1', kind: 'molding-machine', x: 5000, y: 5000, width: 10000, depth: 2800, rotation: 90 })
    expect(sum.equipment[0]!.bounds).toEqual({ left: 3600, top: 0, right: 6400, bottom: 10000 })
    expect(sum.aisles[0]).toMatchObject({ id: 'aisle-1', width: 1500, closed: false, lengthMm: 30000 })
    expect(sum.links).toEqual([{ from: 'eq-1', to: 'eq-2' }])
    expect(sum.flow.cycleTime).toBe(30)
    expect(sum.nextIds).toEqual({ equipment: 'eq-3', aisle: 'aisle-2' })
    expect(sum.notices).toEqual([])
  })

  it('重なり・余白への入り込み・はみ出しを注意に書く', () => {
    let s = sample()
    // eq-2 を eq-1 に重なるまで寄せる（本体が重なり、余白にも入る）
    s = run(s, { type: 'move', ids: ['eq-2'], dx: -9000, dy: 0 })
    // 敷地の外へ 1 台
    const t = findTemplate(INJECTION_PRESET, 'weighing-scale')!
    s = run(s, { type: 'add', equipment: equipmentFromTemplate(t, { id: 'eq-3', name: '重量計 1', center: { x: 40000, y: 5000 } }) })
    const notices = summarizeScene(s).notices
    expect(notices.some((x) => x.startsWith('重なり:') && x.includes('eq-1') && x.includes('eq-2'))).toBe(true)
    expect(notices.some((x) => x.startsWith('余白:'))).toBe(true)
    expect(notices).toContain('はみ出し: 重量計 1（eq-3）が敷地の外形の外に出ている')
  })

  it('空のシーンでも読める（敷地なし、次の id は 1 番）', () => {
    const sum = summarizeScene(createEmptyScene())
    expect(sum).toMatchObject({ site: null, equipment: [], aisles: [], links: [], notices: [], nextIds: { equipment: 'eq-1', aisle: 'aisle-1' } })
  })

  it('背景の画像は入れない', () => {
    const s = { ...sample(), background: { src: 'data:image/png;base64,AAAA', name: 'plan.png', pixelWidth: 10, pixelHeight: 10, x: 0, y: 0, mmPerPixel: 1, calibrated: false } }
    expect(JSON.stringify(summarizeScene(s))).not.toContain('data:image')
  })
})

describe('aiInstructions', () => {
  it('ひな形の種類をすべて載せる', () => {
    const text = aiInstructions()
    for (const t of INJECTION_PRESET) expect(text).toContain(t.kind)
  })

  // 説明に書いた指示の例が、確かめ（planAiCommands）で通ること。書き方と確かめがずれないようにする
  it('説明の指示の例は、どれも今のシーンに当てられる', () => {
    const examples = aiInstructions()
      .split('\n')
      .map((l) => /^- (\{ "type".*\})(?:\s.*)?$/.exec(l)?.[1])
      .filter((x): x is string => !!x)
      .flatMap((x) => {
        try {
          return [JSON.parse(x) as unknown]
        } catch {
          return [] // 「[ ... ]」で省いた例
        }
      })
    expect(examples.length).toBeGreaterThanOrEqual(12)
    // つなぎの例が「もうつないであります」で断られないよう、つなぎを外したシーンで試す
    const s = run(sample(), { type: 'unlink', links: [{ from: 'eq-1', to: 'eq-2' }] })
    for (const ex of examples) {
      const r = planAiCommands(s, [ex])
      expect(r, JSON.stringify(ex)).toMatchObject({ ok: true })
    }
  })
})

describe('buildAiPrompt', () => {
  it('説明・シーンの JSON・頼みを 1 つの文にする', () => {
    const text = buildAiPrompt(sample(), '  成形機をもう 1 台並べて ')
    expect(text).toContain('## 使える指示')
    expect(text).toContain('## 頼み\n成形機をもう 1 台並べて\n')
    const json = /## 今のシーン\n```json\n([\s\S]*?)\n```/.exec(text)?.[1]
    expect(JSON.parse(json!)).toEqual(JSON.parse(JSON.stringify(summarizeScene(sample()))))
  })

  it('頼みが空なら書く場所を示す', () => {
    expect(buildAiPrompt(createEmptyScene())).toContain('（ここに頼みを書いてください）')
  })

  it('説明の返し方の例は parseAiReply で読める', () => {
    const r = parseAiReply('{ "message": "置きます", "commands": [ { "type": "place", "kind": "molding-machine", "x": 5000, "y": 3000 } ] }')
    expect(r.ok).toBe(true)
  })
})
