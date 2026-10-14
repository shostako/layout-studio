// 例の配置（public/examples/）が今の版で読め、重なり・余白への入り込み・はみ出し・再生の知らせが無いことを確かめる。
// 形を変えたときに、例だけ古くなって開けなくなるのを防ぐ。付帯設備がアプリの決まり（整える）どおりに並んでいることも確かめる。
import { describe, expect, it } from 'vitest'
import { arrangeUnit } from './attach'
import { planMetrics } from './compare'
import { layoutSignature } from './layout'
import { layoutChange, layoutGroups } from './plans'
import { unitsOf } from './unit'
import { prepareFlow } from './playback'
import { SCENE_VERSION } from './scene'
import { parsePlanFile } from './sceneFile'

const files = import.meta.glob('../../public/examples/*.json', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

describe('例の配置', () => {
  it('ファイルが 2 つある', () => {
    expect(Object.keys(files).map((f) => f.split('/').pop()).sort()).toEqual(['molding-14.json', 'molding-7.json'])
  })

  for (const [path, text] of Object.entries(files)) {
    const name = path.split('/').pop()!
    it(`${name} は今の版で読め、案に注意が無い`, () => {
      const r = parsePlanFile(text, name)
      if (!r.ok) throw new Error(r.error)
      const want: Record<string, { plans: string[]; layout: string }> = {
        'molding-7.json': { plans: ['7 台 A 往復', '7 台 B 一方通行の周回'], layout: '成形機 7 台（横 1 列）' },
        'molding-14.json': { plans: ['14 台 A 往復', '14 台 B 一方通行の周回', '14 台 C 往復・AGV 2 台'], layout: '成形機 14 台（横 2 列: 7・7）' },
      }
      expect(r.plans.map((p) => p.name)).toEqual(want[name]!.plans)
      // 案はどれも同じ 1 つのレイアウト
      expect(layoutGroups(r).map((g) => g.description)).toEqual([want[name]!.layout])
      // 開いたときに「並びが変わった」と聞かれない（確かめた並びが今の比べ方と合う）
      expect(layoutChange(r)).toBeNull()
      for (const p of r.plans) {
        expect(p.layout!.signature).toBe(layoutSignature(p.scene))
        // 付帯設備は整えるの決まりどおり（整えても動かない）
        for (const id of unitsOf(p.scene).keys()) expect(arrangeUnit(p.scene, id)).toMatchObject({ ok: true, command: null })
        expect(p.scene.version).toBe(SCENE_VERSION)
        const m = planMetrics(p.scene)
        expect({ plan: p.name, overlaps: m.overlaps, intrusions: m.intrusions, outside: m.outside }).toEqual({
          plan: p.name,
          overlaps: 0,
          intrusions: 0,
          outside: 0,
        })
        expect(prepareFlow(p.scene).warnings).toEqual([])
      }
    })
  }
})
