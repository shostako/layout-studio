// AI の応答（コマンドの列）を読み、確かめ、画面と同じコマンド（commands.ts）に直す。DOM に触らない。
// AI の応答は外から来た JSON なので、形を 1 つずつ確かめ、使ってよい操作だけを通す。
// 1 つでも断られたら、どれも当てない（理由と何番目かを返す）。当てるのは呼ぶ側で、batch コマンドにまとめて 1 回の操作にする。

import { DEFAULT_AISLE_WIDTH, nextAisleId, nextAisleName, type Aisle } from './aisle'
import { arrangeUnit, attachUnit, forAnchors, type Side } from './attach'
import { applyCommand, type Command } from './commands'
import { FLOW_LIMITS, nextEquipmentId, nextEquipmentIds, type FlowSettings, type Rotation, type Scene } from './scene'
import { siteArea } from './site'
import { equipmentFromTemplate, findTemplate, nextEquipmentName, type EquipmentTemplate } from './templates'
import { unitsOf } from './unit'
import type { Point } from './viewport'

// 1 回の応答で受け付ける指示の数の上限
export const MAX_AI_COMMANDS = 200
// 座標と移動量の上限（mm、絶対値）。桁を間違えた指示で図面の遠くへ飛ばさないため
export const AI_LENGTH_LIMIT = 1_000_000

// AI の応答の形: { "message": "…", "commands": [ {...}, ... ] }
export type AiReply = { message: string; commands: unknown[] }

// AI が出せる指示。画面のコマンドと同じ形（type と項目名）で、置く・描く・写すだけは id と名前を省ける形にした
export type AiCommand =
  | { type: 'place'; kind: string; x: number; y: number; id?: string; name?: string; width?: number; depth?: number; rotation?: Rotation }
  | { type: 'addAisle'; points: Point[]; width?: number; closed?: boolean; oneWay?: boolean; id?: string; name?: string }
  | { type: 'duplicate'; ids: string[]; dx: number; dy: number; newIds?: string[] }
  | Extract<Command, { type: (typeof PASS_TYPES)[number] }>

// そのまま画面のコマンドとして通す指示と、その項目の形
type Field = 'ids' | 'id' | 'length' | 'number' | 'object' | 'array' | 'point' | 'links' | 'points' | 'site'
const PASS = {
  move: { ids: 'ids', dx: 'length', dy: 'length' },
  rotate: { ids: 'ids', quarterTurns: 'number' },
  rotateAbout: { ids: 'ids', quarterTurns: 'number', pivot: 'point' },
  remove: { ids: 'ids' },
  update: { ids: 'ids', changes: 'object' },
  updateAisle: { ids: 'ids', changes: 'object' },
  removeAisle: { ids: 'ids' },
  moveAisle: { ids: 'ids', dx: 'length', dy: 'length' },
  setAislePoints: { id: 'id', points: 'points' },
  link: { links: 'links' },
  unlink: { links: 'links' },
  setFlow: { changes: 'object' },
  setSite: { site: 'site' },
  setTemplates: { templates: 'array' },
} as const satisfies Record<string, Record<string, Field>>
const PASS_TYPES = Object.keys(PASS) as (keyof typeof PASS)[]

// AI が出せる指示の種類（AI への説明に使う）
export const AI_COMMAND_TYPES: readonly string[] = ['place', 'addAisle', 'duplicate', 'attachUnit', 'arrangeUnits', ...PASS_TYPES]

// AI からは使わせない画面のコマンドと、その理由
const REFUSED: Record<string, string> = {
  add: '設備を置くときは place を使ってください',
  setBackground: '背景の図面は画面で扱います。AI からは変えません',
  calibrateBackground: '背景の図面は画面で扱います。AI からは変えません',
  moveBackground: '背景の図面は画面で扱います。AI からは変えません',
  loadScene: 'シーンをまるごと差し替える操作は AI からは使えません',
  batch: 'まとめ（batch）は使えません。commands に順に並べてください',
}

export type ParseResult = { ok: true; reply: AiReply } | { ok: false; error: string }

// 応答の文字列から JSON を取り出して読む。文字列全体、```json のかこみ、最初の { から最後の } の順に試す
export function parseAiReply(text: string): ParseResult {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: '応答が空です' }
  const t = text.trim()
  const candidates = [t]
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(t)
  if (fenced) candidates.push(fenced[1]!)
  const a = t.indexOf('{')
  const b = t.lastIndexOf('}')
  if (a >= 0 && b > a) candidates.push(t.slice(a, b + 1))
  let data: unknown = undefined
  let found = false
  for (const c of candidates) {
    try {
      data = JSON.parse(c)
      found = true
      break
    } catch {
      // 次を試す
    }
  }
  if (!found) return { ok: false, error: '応答に読める JSON がありません' }
  if (Array.isArray(data)) data = { commands: data }
  if (typeof data !== 'object' || data === null) return { ok: false, error: '応答の JSON が { "message", "commands" } の形ではありません' }
  const r = data as Record<string, unknown>
  if (r.message !== undefined && typeof r.message !== 'string') return { ok: false, error: 'message が文字列ではありません' }
  if (r.commands !== undefined && !Array.isArray(r.commands)) return { ok: false, error: 'commands が配列ではありません' }
  if (r.message === undefined && r.commands === undefined) return { ok: false, error: '応答に message も commands もありません' }
  const commands = (r.commands ?? []) as unknown[]
  if (commands.length > MAX_AI_COMMANDS) return { ok: false, error: `指示が多すぎます（${commands.length} 件。1 回に ${MAX_AI_COMMANDS} 件まで）` }
  return { ok: true, reply: { message: (r.message ?? '') as string, commands } }
}

// 直した 1 つの指示と、その説明（画面に並べる）
export type AiStep = { command: Command; text: string }
export type AiPlan = { ok: true; steps: AiStep[]; scene: Scene } | { ok: false; index: number; error: string }

// 指示の列を、今のシーンに順に当てながら画面のコマンドに直す。id を省いた指示は、その時点のシーンで次の id を振る。
// 断ったときは index（0 から）と理由を返し、シーンは返さない
export function planAiCommands(scene: Scene, commands: readonly unknown[]): AiPlan {
  if (commands.length > MAX_AI_COMMANDS) return { ok: false, index: MAX_AI_COMMANDS, error: `指示が多すぎます（1 回に ${MAX_AI_COMMANDS} 件まで）` }
  let current = scene
  const steps: AiStep[] = []
  for (const [i, raw] of commands.entries()) {
    const label = typeof raw === 'object' && raw !== null && typeof (raw as { type?: unknown }).type === 'string' ? `（${(raw as { type: string }).type}）` : ''
    const refuse = (error: string): AiPlan => ({ ok: false, index: i, error: `${i + 1} 番目の指示${label}: ${error}` })
    const c = toCommand(current, raw)
    if (!c.ok) return refuse(c.error)
    // 付ける・整えるで、もう決まりどおりなら当てるものが無い
    if (c.command === null) continue
    let r
    try {
      r = applyCommand(current, c.command)
    } catch {
      // 形の確かめをすり抜けた値で落ちても、当てずに断る
      return refuse('指示の形が正しくありません')
    }
    if (!r.ok) return refuse(r.error)
    steps.push({ command: c.command, text: c.text ?? describeCommand(current, c.command) })
    current = r.scene
  }
  return { ok: true, steps, scene: current }
}

type ToCommand = { ok: true; command: Command | null; text?: string } | { ok: false; error: string }

function toCommand(scene: Scene, raw: unknown): ToCommand {
  const no = (error: string): ToCommand => ({ ok: false, error })
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return no('指示の形（{ "type": … }）ではありません')
  const r = raw as Record<string, unknown>
  if (typeof r.type !== 'string') return no('type がありません')
  const type = r.type
  if (REFUSED[type]) return no(REFUSED[type]!)
  if (type === 'place') return place(scene, r)
  if (type === 'attachUnit' || type === 'arrangeUnits') return unitCommand(scene, r, type)
  if (type === 'addAisle') return addAisle(scene, r)
  if (type === 'duplicate') {
    const bad = checkFields(r, { ids: 'ids', dx: 'length', dy: 'length' })
    if (bad) return no(bad)
    if (r.newIds !== undefined && checkField(r.newIds, 'ids')) return no('newIds は文字列の配列にしてください')
    const ids = r.ids as string[]
    const newIds = (r.newIds as string[] | undefined) ?? nextEquipmentIds(scene, ids.length)
    return { ok: true, command: { type: 'duplicate', ids, newIds, dx: r.dx as number, dy: r.dy as number } }
  }
  if (!(type in PASS)) return no(`知らない操作です: ${type}（使えるのは ${AI_COMMAND_TYPES.join(', ')}）`)
  const fields: Record<string, Field> = PASS[type as keyof typeof PASS]
  const bad = checkFields(r, fields)
  if (bad) return no(bad)
  // 知らない項目は落とす
  const cmd: Record<string, unknown> = { type }
  for (const k of Object.keys(fields)) cmd[k] = r[k]
  return { ok: true, command: cmd as Command }
}

function checkFields(r: Record<string, unknown>, fields: Record<string, Field>): string | null {
  for (const [k, f] of Object.entries(fields)) {
    const bad = checkField(r[k], f)
    if (bad) return `${k}: ${bad}`
  }
  return null
}

const inLimit = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= AI_LENGTH_LIMIT
const LIMIT_TEXT = `±${AI_LENGTH_LIMIT} mm の内の数にしてください`

function checkPoints(v: unknown): string | null {
  if (!Array.isArray(v)) return '点 { "x", "y" } の配列にしてください'
  for (const p of v) {
    if (typeof p !== 'object' || p === null) return '点 { "x", "y" } の配列にしてください'
    const q = p as Record<string, unknown>
    if (!inLimit(q.x) || !inLimit(q.y)) return `点の座標は ${LIMIT_TEXT}`
  }
  return null
}

function checkField(v: unknown, f: Field): string | null {
  switch (f) {
    case 'ids':
      return Array.isArray(v) && v.every((x) => typeof x === 'string') ? null : '文字列の配列にしてください'
    case 'id':
      return typeof v === 'string' && v ? null : '文字列にしてください'
    case 'length':
      return inLimit(v) ? null : LIMIT_TEXT
    case 'number':
      return typeof v === 'number' && Number.isFinite(v) ? null : '数にしてください'
    case 'object':
      return typeof v === 'object' && v !== null && !Array.isArray(v) ? null : '{ … } の形にしてください'
    case 'array':
      return Array.isArray(v) ? null : '[ … ] の配列にしてください'
    case 'links':
      return Array.isArray(v) &&
        v.every((l) => typeof l === 'object' && l !== null && typeof l.from === 'string' && typeof l.to === 'string')
        ? null
        : '{ "from", "to" } の配列にしてください'
    case 'point':
      return checkPoints([v]) ? '点 { "x", "y" } にしてください' : null
    case 'points':
      return checkPoints(v)
    case 'site':
      if (v === null) return null
      if (typeof v !== 'object' || Array.isArray(v)) return '{ "points": [...] } か null にしてください'
      return checkPoints((v as Record<string, unknown>).points)
  }
}

// ひな形から置く。寸法・色・余白はひな形の値で、名前は「成形機 n」の続き
function place(scene: Scene, r: Record<string, unknown>): ToCommand {
  const no = (error: string): ToCommand => ({ ok: false, error })
  if (typeof r.kind !== 'string') return no('kind（設備の種類）がありません')
  const t = findTemplate(scene.templates, r.kind)
  if (!t) return no(`知らない設備の種類です: ${r.kind}（使えるのは ${scene.templates.map((x) => x.kind).join(', ')}。種類を足すには setTemplates）`)
  const bad = checkFields(r, { x: 'length', y: 'length' })
  if (bad) return no(bad)
  if (r.id !== undefined && checkField(r.id, 'id')) return no('id は文字列にしてください')
  if (r.name !== undefined && (typeof r.name !== 'string' || !r.name.trim())) return no('name は空でない文字列にしてください')
  for (const k of ['width', 'depth', 'rotation'] as const)
    if (r[k] !== undefined && typeof r[k] !== 'number') return no(`${k} は数にしてください`)
  const equipment = equipmentFromTemplate(t, {
    id: (r.id as string | undefined) ?? nextEquipmentId(scene),
    name: (r.name as string | undefined)?.trim() ?? nextEquipmentName(scene, t),
    center: { x: r.x as number, y: r.y as number },
    width: r.width as number | undefined,
    depth: r.depth as number | undefined,
    rotation: r.rotation as Rotation | undefined,
  })
  return { ok: true, command: { type: 'add', equipment } }
}

const SIDES = ['top', 'bottom', 'left', 'right'] as const

// 付帯設備を付ける（attachUnit）・整える（arrangeUnits）。計算は attach.ts。ids は基準の設備（整えるは省くと全部）
function unitCommand(scene: Scene, r: Record<string, unknown>, type: 'attachUnit' | 'arrangeUnits'): ToCommand {
  const no = (error: string): ToCommand => ({ ok: false, error })
  if (r.ids !== undefined && checkField(r.ids, 'ids')) return no('ids は基準の設備の id の配列にしてください')
  for (const k of ['side', 'toward'] as const)
    if (r[k] !== undefined && !SIDES.includes(r[k] as (typeof SIDES)[number])) return no(`${k} は ${SIDES.join('・')} のどれかです`)
  const all = [...unitsOf(scene).keys()]
  const ids = (r.ids as string[] | undefined) ?? (type === 'arrangeUnits' ? all : undefined)
  if (!ids || ids.length === 0) return no(type === 'attachUnit' ? 'ids（付ける基準の設備の id）がありません' : '基準の設備がありません')
  const opts = { side: r.side as Side | undefined, toward: r.toward as Side | undefined }
  const f = type === 'attachUnit' ? (s: Scene, id: string) => attachUnit(s, id, opts) : (s: Scene, id: string) => arrangeUnit(s, id)
  const res = forAnchors(scene, ids, f, (s, c) => {
    const a = applyCommand(s, c)
    return a.ok ? a.scene : a.error
  })
  if (!res.ok) return no(res.error)
  return { ok: true, command: res.command, text: `${type === 'attachUnit' ? '付帯設備を付ける' : '付帯設備を整える'}: ${res.notes.join('。')}` }
}

// 通路を描く。幅を省けば最初の値、周回を省けば開いた通路、一方通行を省けば両方向
function addAisle(scene: Scene, r: Record<string, unknown>): ToCommand {
  const no = (error: string): ToCommand => ({ ok: false, error })
  const bad = checkPoints(r.points)
  if (bad) return no(`points: ${bad}`)
  if (r.width !== undefined && typeof r.width !== 'number') return no('width は数にしてください')
  if (r.closed !== undefined && typeof r.closed !== 'boolean') return no('closed は true か false にしてください')
  if (r.oneWay !== undefined && typeof r.oneWay !== 'boolean') return no('oneWay は true か false にしてください')
  if (r.id !== undefined && checkField(r.id, 'id')) return no('id は文字列にしてください')
  if (r.name !== undefined && typeof r.name !== 'string') return no('name は文字列にしてください')
  const aisle: Aisle = {
    id: (r.id as string | undefined) ?? nextAisleId(scene),
    name: (r.name as string | undefined) ?? nextAisleName(scene),
    points: (r.points as Point[]).map(({ x, y }) => ({ x, y })),
    width: (r.width as number | undefined) ?? DEFAULT_AISLE_WIDTH,
    closed: (r.closed as boolean | undefined) ?? false,
    ...(r.oneWay === true ? { oneWay: true } : {}),
  }
  return { ok: true, command: { type: 'addAisle', aisle } }
}

// ---- 説明 ----

const mm = (v: number) => `${Math.round(v).toLocaleString('ja-JP')} mm`
const signed = (v: number) => (v > 0 ? '+' : '') + mm(v)

// 設備や通路の名前を並べる（4 つ目からは「ほか n」）
function names(list: readonly { id: string; name: string }[], ids: readonly string[], unit: string): string {
  const ns = ids.map((id) => list.find((x) => x.id === id)?.name ?? id)
  return ns.length <= 3 ? ns.join('、') : `${ns.slice(0, 3).join('、')} ほか ${ns.length - 3} ${unit}`
}

// ひな形の一覧の差し替えを、足す・消す・変える種類の名前で書く
function describeTemplates(before: readonly EquipmentTemplate[], after: readonly EquipmentTemplate[]): string {
  const added = after.filter((t) => !before.some((b) => b.kind === t.kind)).map((t) => t.name)
  const removed = before.filter((b) => !after.some((t) => t.kind === b.kind)).map((t) => t.name)
  const changed = after
    .filter((t) => {
      const b = before.find((x) => x.kind === t.kind)
      return b !== undefined && JSON.stringify(b) !== JSON.stringify(t)
    })
    .map((t) => t.name)
  const order = (list: readonly EquipmentTemplate[]) => list.map((t) => t.kind).filter((k) => before.some((b) => b.kind === k) && after.some((a) => a.kind === k)).join()
  const parts = [
    added.length ? `足す: ${added.join('、')}` : '',
    removed.length ? `消す: ${removed.join('、')}` : '',
    changed.length ? `変える: ${changed.join('、')}` : '',
    order(before) !== order(after) ? '並べ替える' : '',
  ].filter(Boolean)
  return `設備の種類の一覧を変える（${parts.join('。') || '変わりなし'}）`
}

// コマンドを人が読む文にする。scene は当てる前のシーン
export function describeCommand(scene: Scene, cmd: Command): string {
  const eqNames = (ids: readonly string[]) => names(scene.equipment, ids, '台')
  const aisleNames = (ids: readonly string[]) => names(scene.aisles, ids, '本')
  const linkText = (links: readonly { from: string; to: string }[]) => links.map((l) => `${eqNames([l.from])} → ${eqNames([l.to])}`).join('、')
  switch (cmd.type) {
    case 'add': {
      const e = cmd.equipment
      return `${e.name} を置く（中心 x ${mm(e.x)}・y ${mm(e.y)}、${mm(e.width)} × ${mm(e.depth)}、回転 ${e.rotation}°）`
    }
    case 'move':
      return `${eqNames(cmd.ids)} を動かす（x ${signed(cmd.dx)}・y ${signed(cmd.dy)}）`
    case 'rotate':
      return `${eqNames(cmd.ids)} を${cmd.quarterTurns >= 0 ? '時計回り' : '反時計回り'}に ${Math.abs(cmd.quarterTurns) * 90}° 回す`
    case 'rotateAbout':
      return `${eqNames(cmd.ids)} をまとめて (${mm(cmd.pivot.x)}, ${mm(cmd.pivot.y)}) のまわりに${cmd.quarterTurns >= 0 ? '時計回り' : '反時計回り'}に ${Math.abs(cmd.quarterTurns) * 90}° 回す`
    case 'remove':
      return `${eqNames(cmd.ids)} を消す`
    case 'duplicate':
      return `${eqNames(cmd.ids)} を写して置く（x ${signed(cmd.dx)}・y ${signed(cmd.dy)}）`
    case 'update': {
      const c = cmd.changes
      const parts: string[] = []
      if (c.name !== undefined) parts.push(`名前「${c.name}」`)
      if (c.width !== undefined) parts.push(`幅 ${mm(c.width)}`)
      if (c.depth !== undefined) parts.push(`奥行 ${mm(c.depth)}`)
      if (c.color !== undefined) parts.push(`色 ${c.color}`)
      if (c.clearance !== undefined) parts.push('余白')
      return `${eqNames(cmd.ids)} の${parts.join('・')}を変える`
    }
    case 'addAisle': {
      const a = cmd.aisle
      return `${a.name} を描く（幅 ${mm(a.width)}、頂点 ${a.points.length}${a.closed ? '、周回' : ''}${a.oneWay ? '、一方通行' : ''}）`
    }
    case 'updateAisle': {
      const c = cmd.changes
      const way = c.oneWay !== undefined ? `${c.oneWay ? '一方通行' : '両方向'}にする` : ''
      const parts = [c.name !== undefined ? `名前「${c.name}」` : '', c.width !== undefined ? `幅 ${mm(c.width)}` : ''].filter(Boolean)
      if (!parts.length) return `${aisleNames(cmd.ids)} を${way}`
      if (way) return `${aisleNames(cmd.ids)} の${parts.join('・')}を変え、${way}`
      return `${aisleNames(cmd.ids)} の${parts.join('・')}を変える`
    }
    case 'removeAisle':
      return `${aisleNames(cmd.ids)} を消す`
    case 'moveAisle':
      return `${aisleNames(cmd.ids)} を動かす（x ${signed(cmd.dx)}・y ${signed(cmd.dy)}）`
    case 'setAislePoints':
      return `${aisleNames([cmd.id])} の頂点を差し替える（頂点 ${cmd.points.length}）`
    case 'link':
      return `つなぐ: ${linkText(cmd.links)}`
    case 'unlink':
      return `つなぎを外す: ${linkText(cmd.links)}`
    case 'setFlow': {
      const c = cmd.changes as Partial<FlowSettings>
      const parts = (Object.keys(FLOW_LIMITS) as (keyof FlowSettings)[])
        .filter((k) => c[k] !== undefined)
        .map((k) => `${FLOW_LIMITS[k].label} ${c[k]}`)
      return `流れの再生の数値を変える: ${parts.join('、')}`
    }
    case 'setSite':
      return cmd.site === null
        ? '敷地の外形を消す'
        : `敷地の外形を描く（頂点 ${cmd.site.points.length}、${(siteArea(cmd.site) / 1e6).toLocaleString('ja-JP', { maximumFractionDigits: 1 })} m²）`
    case 'setBackground':
    case 'calibrateBackground':
    case 'moveBackground':
      return '背景の図面を変える'
    case 'setTemplates':
      return describeTemplates(scene.templates, cmd.templates)
    case 'loadScene':
      return 'シーンを差し替える'
    case 'batch':
      return `${cmd.commands.length} 個の操作をまとめて当てる`
  }
}
