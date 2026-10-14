// AI に渡す説明: 今のシーンの要約（JSON）と、使える指示の書き方をまとめた文。DOM に触らない。
// キーが無くても、この文をほかの AI のチャットに貼り、返ってきた応答を「応答の JSON を貼って確かめる」で試せる。
// 本物の AI をつなぐときも、同じ文を送る（指示の書き方は ai.ts の確かめと合わせてある）。

import { AI_LENGTH_LIMIT, MAX_AI_COMMANDS } from './ai'
import { aisleLength, nextAisleId } from './aisle'
import { findOverlaps } from './overlap'
import { FLOW_LIMITS, footprint, nextEquipmentId, type FlowSettings, type Scene } from './scene'
import { equipmentOutsideSite, siteArea, siteBounds } from './site'
import { TEMPLATES } from './templates'

// 長さは 1 mm に丸める（AI に渡す文を短くするため）
const r = (v: number) => Math.round(v)

// 今のシーンの要約。AI が読む JSON にする値（背景の画像は入れない。図面の画像は人が画面で合わせる）
export type SceneSummary = {
  unit: 'mm'
  site: { points: { x: number; y: number }[]; bounds: Box; areaM2: number } | null
  equipment: {
    id: string
    kind: string
    name: string
    x: number
    y: number
    width: number
    depth: number
    rotation: number
    bounds: Box
    clearance: { top: number; right: number; bottom: number; left: number }
  }[]
  aisles: { id: string; name: string; width: number; closed: boolean; points: { x: number; y: number }[]; lengthMm: number }[]
  links: { from: string; to: string }[]
  flow: FlowSettings
  notices: string[]
  nextIds: { equipment: string; aisle: string }
}

// 図面の向きの外接の長方形（左・上・右・下の座標）
type Box = { left: number; top: number; right: number; bottom: number }
const box = (x: number, y: number, width: number, height: number): Box => ({ left: r(x), top: r(y), right: r(x + width), bottom: r(y + height) })

export function summarizeScene(scene: Scene): SceneSummary {
  const name = (id: string) => scene.equipment.find((e) => e.id === id)?.name ?? id
  const aisleName = (id: string) => scene.aisles.find((a) => a.id === id)?.name ?? id
  const notices: string[] = []
  for (const o of findOverlaps(scene)) {
    if (o.kind === 'equipment') notices.push(`重なり: ${name(o.a)}（${o.a}）と ${name(o.b)}（${o.b}）の本体`)
    else if (o.kind === 'aisle') notices.push(`重なり: ${name(o.equipment)}（${o.equipment}）と通路 ${aisleName(o.aisle)}（${o.aisle}）`)
    else notices.push(`余白: ${name(o.equipment)}（${o.equipment}）の本体が ${name(o.owner)}（${o.owner}）の保守用の余白に入っている`)
  }
  for (const id of equipmentOutsideSite(scene)) notices.push(`はみ出し: ${name(id)}（${id}）が敷地の外形の外に出ている`)
  const site = scene.site
  return {
    unit: 'mm',
    site: site
      ? (() => {
          const b = siteBounds(site)
          return { points: site.points.map((p) => ({ x: r(p.x), y: r(p.y) })), bounds: box(b.x, b.y, b.width, b.height), areaM2: Math.round(siteArea(site) / 1e4) / 100 }
        })()
      : null,
    equipment: scene.equipment.map((e) => {
      const f = footprint(e)
      return {
        id: e.id,
        kind: e.kind,
        name: e.name,
        x: r(e.x),
        y: r(e.y),
        width: r(e.width),
        depth: r(e.depth),
        rotation: e.rotation,
        bounds: box(f.x, f.y, f.width, f.height),
        clearance: { ...e.clearance },
      }
    }),
    aisles: scene.aisles.map((a) => ({
      id: a.id,
      name: a.name,
      width: r(a.width),
      closed: a.closed,
      oneWay: a.oneWay === true,
      points: a.points.map((p) => ({ x: r(p.x), y: r(p.y) })),
      lengthMm: r(aisleLength(a)),
    })),
    links: scene.links.map((l) => ({ from: l.from, to: l.to })),
    flow: { ...scene.flow },
    notices,
    nextIds: { equipment: nextEquipmentId(scene), aisle: nextAisleId(scene) },
  }
}

const n = (v: number) => v.toLocaleString('en-US')

// 指示の書き方（シーンに依らない部分）。ai.ts の planAiCommands が受け付ける形と合わせる
export function aiInstructions(): string {
  const templates = TEMPLATES.map(
    (t) => `- ${t.kind}（${t.name}）: 幅 ${n(t.width)} × 奥行 ${n(t.depth)}、余白 ${n(t.clearance.top)}`,
  ).join('\n')
  const flow = (Object.keys(FLOW_LIMITS) as (keyof FlowSettings)[])
    .map((k) => `${k}（${FLOW_LIMITS[k].label}、${n(FLOW_LIMITS[k].min)}〜${n(FLOW_LIMITS[k].max)}${FLOW_LIMITS[k].integer ? '、整数' : ''}）`)
    .join('、')
  return `あなたは射出成形工場の設備レイアウトを検討する図面エディタ layout-studio の操作係です。
頼みに合わせて、図面の設備・通路を動かす指示（コマンド）の列を JSON で返してください。

## 図面の決まり
- 長さはすべて mm。原点は図面の左上で、右が +x、下が +y。
- 設備の x, y は本体の中心。width は回転 0 のときの x 方向、depth は y 方向の長さ。
- rotation は 0・90・180・270（画面の見た目で時計回り）。90 と 270 では幅と奥行が入れ替わる。
- bounds は回転を考えた本体の外接の長方形（left, top, right, bottom）。
- clearance は保守用の余白（回転 0 のときの上・右・下・左の辺から外へ取る幅）。設備と一緒に回る。
- 他の設備の本体が余白に入ると注意になる。余白どうしの重なりはかまわない。
- 通路（AGV の通路）は中心線の頂点の列と幅。closed が true なら周回。oneWay が true なら一方通行で、AGV は頂点の順（points[0] → points[1] → …）にだけ走る。
- AGV の出入り口は、いちばん先の通路の points[0]。AGV は出入り口からストッカーの乗り場（いちばん近い中心線の上の点）へ行き、別に探した近道で出入り口へ帰る。
- links は工程のつなぎ（from の設備から to の設備へものが流れる）。輪にはできない。

## 返し方
次の形の JSON だけを返してください。説明は message に日本語で書きます。
{ "message": "何をするかの一言", "commands": [ { "type": "...", ... }, ... ] }
- commands は上から順に、今のシーンに当てます。1 つでも断られると、どれも当たりません。
- 1 回に ${MAX_AI_COMMANDS} 件まで。座標と移動量は ±${n(AI_LENGTH_LIMIT)} mm の内。
- 頼みが分からないとき、できないときは、commands を空にして message で理由を書いてください。

## 使える指示
- { "type": "place", "kind": "molding-machine", "x": 5000, "y": 3000 }
  ひな形から設備を置く（x, y は中心）。省ける項目: id、name、width、depth、rotation。
  id を省くと eq-1, eq-2, … の続きを振ります。同じ応答の中で後から参照する設備は id を書いてください（今の続きは nextIds）。
- { "type": "move", "ids": ["eq-1"], "dx": 1000, "dy": 0 } 設備をずらす
- { "type": "rotate", "ids": ["eq-1"], "quarterTurns": 1 } 設備を中心のまわりに 90° × n 回す（正が時計回り）
- { "type": "remove", "ids": ["eq-1"] } 設備を消す（つなぎも消える）
- { "type": "duplicate", "ids": ["eq-1"], "dx": 0, "dy": 3000 } 設備を写してずらして置く（newIds は省ける）
- { "type": "update", "ids": ["eq-1"], "changes": { "name": "成形機 A", "width": 6500, "depth": 2200, "color": "#5b8bd9", "clearance": { "top": 800 } } }
  名前・寸法・色（#rrggbb）・余白を変える。書いた項目だけ変わる
- { "type": "addAisle", "points": [ { "x": 0, "y": 8000 }, { "x": 20000, "y": 8000 } ] }
  通路を描く。省ける項目: width（1500）、closed（false）、oneWay（false）、id、name
- { "type": "updateAisle", "ids": ["aisle-1"], "changes": { "name": "主通路", "width": 1800, "oneWay": true } } 通路の名前・幅・一方通行を変える（向きを逆にするには setAislePoints で頂点を逆順に）
- { "type": "moveAisle", "ids": ["aisle-1"], "dx": 0, "dy": 500 } 通路を中心線ごとずらす
- { "type": "setAislePoints", "id": "aisle-1", "points": [ ... ] } 通路の中心線の頂点を差し替える
- { "type": "removeAisle", "ids": ["aisle-1"] } 通路を消す
- { "type": "link", "links": [ { "from": "eq-1", "to": "eq-2" } ] } 工程をつなぐ / "unlink" で外す
- { "type": "setFlow", "changes": { "cycleTime": 25 } } 流れの再生の数値を変える。項目: ${flow}
- { "type": "setSite", "site": { "points": [ { "x": 0, "y": 0 }, { "x": 30000, "y": 0 }, { "x": 30000, "y": 20000 }, { "x": 0, "y": 20000 } ] } }
  敷地の外形を描く（多角形の頂点）。null で消す
- 使えないもの: 背景の図面の操作、シーンの差し替え、add（place を使う）、batch。

## 設備の種類（kind）と、ひな形の寸法・余白（mm、架空の目安）
${templates}

## 配置のこつ
- 本体どうし、本体と通路の帯（中心線から幅の半分ずつ）を重ねない。他の設備の本体を余白に入れない。
- 成形機は配置の基準。頼まれない限り成形機を動かさない・回さない。
- 取出機は成形機の上に載せる（重ねて置き、成形機 → 取出機とつなぐ。つないだ組の重なりは注意にならない）。取出機の梁は成形機の横長の辺を横切り、取り出し側へ張り出す。
- 取り出し側（成形機の 2 つの長辺のどちらに成形品を落とすか）は、頼みに書いてあればそれ。無ければ、その成形機につないだ取出機が張り出している側。取出機も無ければ、成形機が横（長辺が x）なら下（y の大きい側）、縦（長辺が y）なら右（x の大きい側）。
- 型抜き機・トリミング機・台車ストッカー・予備のストッカーを、取り出し側の長辺に沿って取出機の落とし口の側からこの順に並べる。重量計は使わない。
- つなぎは 取出機 → 型抜き機 → トリミング機 と、トリミング機 → 台車ストッカー、トリミング機 → 予備のストッカー の 2 本の枝（ストッカーから予備へはつながない。ストッカーから先へは成形品が流れない）。
- ストッカーと予備は列の端に置き、AGV の通路に面させる。通路は出入り口からストッカーの近くまでつなぐ。
- 本体どうしの間は、両方の余白の大きい方にする（付帯設備どうし 500 mm、成形機のまわり 1000 mm）。
- 敷地の外形があれば、本体をその内に収める。
- 並べるときは bounds と余白から間隔を計算し、座標は整数の mm にする。`
}

// 貼り付けて使う文: 指示の書き方、今のシーンの要約、頼み（あれば）
export function buildAiPrompt(scene: Scene, request = ''): string {
  const summary = JSON.stringify(summarizeScene(scene), null, 1)
  const ask = request.trim()
  return `${aiInstructions()}

## 今のシーン
\`\`\`json
${summary}
\`\`\`

## 頼み
${ask || '（ここに頼みを書いてください）'}
`
}
