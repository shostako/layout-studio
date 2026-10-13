// 例の配置（public/examples/）が今の版で読め、重なり・余白への入り込み・はみ出し・再生の知らせが無いことを確かめる。
// 形を変えたときに、例だけ古くなって開けなくなるのを防ぐ。
import { describe, expect, it } from 'vitest'
import { planMetrics } from './compare'
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
      expect(r.plans).toHaveLength(4)
      for (const p of r.plans) {
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
