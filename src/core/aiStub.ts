// 本物の AI の代わりに、決まった応答を返す差し替え部品。外へは何も送らない。DOM に触らない。
// 本物をつなぐときは、同じ AiClient の形（頼みとシーンを受け、応答の文字列を返す）で作って差し替える。

import { equipmentBounds, type Scene } from './scene'
import { siteBounds } from './site'
import { TEMPLATES } from './templates'

export type AiClient = {
  name: string
  // 頼み（日本語の文）と今のシーンを渡し、AI の応答の文字列（JSON）を受け取る
  ask(request: string, scene: Scene): Promise<string>
}

// 差し替え部品が答えられる頼み方の例（画面の選択肢に出す）
export const STUB_EXAMPLES: readonly string[] = [
  '成形機を3台、2000 mm 間隔で横に並べて',
  '台車ストッカーを2台、500 mm 間隔で縦に並べて',
  '全部の設備を右へ 1000 mm 動かして',
  'サイクル時間を 20 秒にして',
  'eq-999 を消して', // 無い設備。断られる例
  '背景の図面を外して', // AI から使えない操作。断られる例
]

const reply = (message: string, commands: unknown[]) => JSON.stringify({ message, commands }, null, 2)

// 頼みの文から決まった応答を作る。数（台数・間隔・移動量・秒）だけは文から拾う
export function stubReply(request: string, scene: Scene): string {
  const text = request.normalize('NFKC')
  const num = (re: RegExp) => {
    const m = re.exec(text)
    return m ? Number(m[1]) : undefined
  }

  // 「〇〇を n 台、d mm 間隔で横（縦）に並べて」
  const t = TEMPLATES.find((x) => text.includes(x.name))
  const count = num(/(\d+)\s*台/)
  if (t && count !== undefined && /並べ/.test(text)) {
    if (count < 1 || count > 20) return reply('1 台から 20 台までにしてください。', [])
    const gap = num(/(\d+)\s*mm\s*間隔/) ?? 1000
    const vertical = /縦/.test(text)
    // 置いてある設備の下（縦なら右）、無ければ敷地の左上、どちらも無ければ (5000, 5000) から並べる
    const box = equipmentBounds(scene.equipment)
    const site = scene.site ? siteBounds(scene.site) : null
    const margin = 2000
    let x0 = (site?.x ?? 0) + margin + t.width / 2
    let y0 = (site?.y ?? 0) + margin + t.depth / 2
    if (!site && !box) [x0, y0] = [5000, 5000]
    if (box) {
      if (vertical) [x0, y0] = [box.x + box.width + margin + t.width / 2, box.y + t.depth / 2]
      else [x0, y0] = [box.x + t.width / 2, box.y + box.height + margin + t.depth / 2]
    }
    const step = (vertical ? t.depth : t.width) + gap
    const commands = Array.from({ length: count }, (_, i) => ({
      type: 'place',
      kind: t.kind,
      x: vertical ? x0 : x0 + i * step,
      y: vertical ? y0 + i * step : y0,
    }))
    return reply(`${t.name}を ${count} 台、本体の間を ${gap} mm あけて${vertical ? '縦' : '横'}に並べます。`, commands)
  }

  // 「全部の設備を右（左・上・下）へ d mm 動かして」
  const dist = num(/(\d+)\s*mm/)
  if (/全部/.test(text) && /動か/.test(text) && dist !== undefined) {
    if (scene.equipment.length === 0) return reply('動かす設備がありません。', [])
    const [dx, dy] = /左/.test(text) ? [-dist, 0] : /上/.test(text) ? [0, -dist] : /下/.test(text) ? [0, dist] : [dist, 0]
    return reply(`設備 ${scene.equipment.length} 台をまとめて動かします。`, [{ type: 'move', ids: scene.equipment.map((e) => e.id), dx, dy }])
  }

  // 「サイクル時間を n 秒にして」
  const sec = num(/(\d+(?:\.\d+)?)\s*秒/)
  if (/サイクル/.test(text) && sec !== undefined) return reply(`サイクル時間を ${sec} 秒にします。`, [{ type: 'setFlow', changes: { cycleTime: sec } }])

  // 「eq-n を消して」。無い設備でもそのまま出す（断られる例）
  const id = /(eq-\d+)/.exec(text)?.[1]
  if (id && /消/.test(text)) {
    const eq = scene.equipment.find((e) => e.id === id)
    return reply(eq ? `${eq.name} を消します。` : `${id} を消します。`, [{ type: 'remove', ids: [id] }])
  }

  // 「背景の図面を外して」。AI から使えない操作を出す（断られる例）
  if (/背景/.test(text)) return reply('背景の図面を外します。', [{ type: 'setBackground', background: null }])

  return reply(
    'これは本物の AI ではなく、決まった頼み方にだけ答える差し替え部品です。例から選ぶか、例の数を変えて頼んでください。',
    [],
  )
}

export function createStubClient(): AiClient {
  return { name: '差し替え部品（本物の AI ではない）', ask: (request, scene) => Promise.resolve(stubReply(request, scene)) }
}
