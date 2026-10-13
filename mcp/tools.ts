// MCP サーバーの道具: 案の JSON ファイルに対して、要約を見る・指示を確かめる・指示を当てる。
// 中身は画面と同じ src/core/ の純関数（summarizeScene・planAiCommands・batch コマンド）を通す。
// ファイルの読み書きは呼ぶ側（server.ts）から渡してもらい、ここは文字列だけを扱う（テストで差し替えられるように）。

import { AI_COMMAND_TYPES, MAX_AI_COMMANDS, parseAiReply, planAiCommands } from '../src/core/ai'
import { aiInstructions, summarizeScene } from '../src/core/aiPrompt'
import { applyCommand } from '../src/core/commands'
import { planMetrics } from '../src/core/compare'
import { activePlan, applyPlanCommand, nextPlanIds, type Plan, type PlanSet } from '../src/core/plans'
import type { Scene } from '../src/core/scene'
import { PLAN_FILE_FORMAT, parsePlanFile, serializePlanSet, serializeScene } from '../src/core/sceneFile'

// ファイルの読み書き。read はファイルが無ければ null
export type FileIo = {
  read(path: string): string | null
  write(path: string, text: string): void
}

export type ToolResult = { text: string; isError: boolean }

// MCP の tools/list に出す形
export type ToolDef = { name: string; description: string; inputSchema: Record<string, unknown> }

const FILE = {
  type: 'string',
  description:
    'layout-studio の画面の「保存」で書き出した JSON ファイルのパス（案の束、またはシーン 1 つ）。相対パスは MCP サーバーを起動したフォルダから',
}
const PLAN = { type: 'string', description: '案の id（plan-1 など）または名前。省くと画面で開いていた案' }
const COMMANDS = {
  type: 'array',
  items: { type: 'object' },
  maxItems: MAX_AI_COMMANDS,
  description: `指示の列（書き方は get_instructions）。使える type: ${AI_COMMAND_TYPES.join(', ')}`,
}

export const TOOLS: ToolDef[] = [
  {
    name: 'get_instructions',
    description: '図面の決まり（mm、座標の向き）、指示（コマンド）の書き方、設備の種類と寸法、配置のこつを返す。指示を書く前に 1 回読む',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'summarize',
    description: '案の JSON ファイルを読み、案の一覧と、1 つの案の要約（設備・通路・敷地・つなぎ・注意・次の id）と面積の数字を返す。ファイルは変えない',
    inputSchema: { type: 'object', properties: { file: FILE, plan: PLAN }, required: ['file'] },
  },
  {
    name: 'check_commands',
    description: '指示の列を案に当てたらどうなるかを確かめる（ファイルは変えない）。通れば指示ごとの説明と、当てた後の注意・面積を返す。1 つでも断られたら何番目かと理由を返す',
    inputSchema: { type: 'object', properties: { file: FILE, plan: PLAN, commands: COMMANDS }, required: ['file', 'commands'] },
  },
  {
    name: 'apply_commands',
    description:
      '指示の列を確かめてから案に当て、ファイルに書き戻す。1 つでも断られたらどれも当てず、ファイルも変えない。' +
      'new_plan に名前を書くと、元の案は残し、写しを作ってそこに当てる（案を比べるときに使う）',
    inputSchema: {
      type: 'object',
      properties: {
        file: FILE,
        plan: PLAN,
        commands: COMMANDS,
        new_plan: { type: 'string', description: '写しの案の名前。省くと元の案を書き換える' },
      },
      required: ['file', 'commands'],
    },
  },
]

const ok = (text: string): ToolResult => ({ text, isError: false })
const err = (text: string): ToolResult => ({ text, isError: true })
const json = (v: unknown) => JSON.stringify(v, null, 1)

// 読んだファイル。single はシーン 1 つのファイル（書き戻すときも同じ形にする）
type Loaded = { set: PlanSet; single: boolean }

function load(io: FileIo, path: string): { ok: true; file: Loaded } | { ok: false; error: string } {
  let text: string | null
  try {
    text = io.read(path)
  } catch (e) {
    return { ok: false, error: `ファイルを読めませんでした: ${path}（${e instanceof Error ? e.message : String(e)}）` }
  }
  if (text === null) return { ok: false, error: `ファイルがありません: ${path}。画面の「保存」で書き出した JSON ファイルを指定してください` }
  const r = parsePlanFile(text, baseName(path))
  if (!r.ok) return { ok: false, error: `${path}: ${r.error}` }
  let single = true
  try {
    const d = JSON.parse(text) as { format?: unknown } | null
    single = !(typeof d === 'object' && d !== null && d.format === PLAN_FILE_FORMAT)
  } catch {
    // parsePlanFile が読めたので、ここには来ない
  }
  return { ok: true, file: { set: { plans: r.plans, active: r.active }, single } }
}

function baseName(path: string): string {
  const b = path.split(/[\\/]/).pop() ?? path
  return b.replace(/\.json$/i, '') || '案 1'
}

function findPlan(set: PlanSet, key: unknown): Plan | string {
  if (key === undefined || key === null || key === '') return activePlan(set)
  if (typeof key !== 'string') return 'plan は文字列で書いてください'
  const p = set.plans.find((q) => q.id === key) ?? set.plans.find((q) => q.name === key.trim())
  return p ?? `案が見つかりません: ${key}（あるのは ${set.plans.map((q) => `${q.id}「${q.name}」`).join('、')}）`
}

// 比べる表と同じ数字を、読みやすい単位にする（m²・m）
function metrics(scene: Scene) {
  const m = planMetrics(scene)
  const m2 = (v: number) => Math.round(v / 1e4) / 100
  return {
    siteAreaM2: m.siteArea === null ? null : m2(m.siteArea),
    extent: m.extent && { widthMm: Math.round(m.extent.width), heightMm: Math.round(m.extent.height), areaM2: m2(m.extent.width * m.extent.height) },
    bodyAreaM2: m2(m.bodyArea),
    clearanceAreaM2: m2(m.clearanceArea),
    equipmentCount: m.equipmentCount,
    aisleLengthMm: Math.round(m.aisleLength),
    overlaps: m.overlaps,
    intrusions: m.intrusions,
    outside: m.outside,
  }
}

// commands は配列のほか、AI の応答の文字列（{ message, commands } や ```json のかこみ）も受ける
function readCommands(raw: unknown): { ok: true; commands: unknown[] } | { ok: false; error: string } {
  if (Array.isArray(raw)) return { ok: true, commands: raw }
  if (typeof raw === 'string') {
    const r = parseAiReply(raw)
    return r.ok ? { ok: true, commands: r.reply.commands } : r
  }
  return { ok: false, error: 'commands は指示の配列で書いてください' }
}

type Args = Record<string, unknown>

export function callTool(name: string, args: Args | undefined, io: FileIo): ToolResult {
  const a = args ?? {}
  switch (name) {
    case 'get_instructions':
      return ok(aiInstructions())
    case 'summarize':
      return summarize(a, io)
    case 'check_commands':
      return run(a, io, false)
    case 'apply_commands':
      return run(a, io, true)
    default:
      return err(`道具がありません: ${name}`)
  }
}

function fileArg(a: Args): string | null {
  return typeof a.file === 'string' && a.file.trim() ? a.file.trim() : null
}

function summarize(a: Args, io: FileIo): ToolResult {
  const path = fileArg(a)
  if (!path) return err('file（JSON ファイルのパス）を書いてください')
  const l = load(io, path)
  if (!l.ok) return err(l.error)
  const p = findPlan(l.file.set, a.plan)
  if (typeof p === 'string') return err(p)
  return ok(
    json({
      file: path,
      plans: l.file.set.plans.map((q) => ({ id: q.id, name: q.name, equipment: q.scene.equipment.length, active: q.id === l.file.set.active })),
      plan: { id: p.id, name: p.name },
      metrics: metrics(p.scene),
      scene: summarizeScene(p.scene),
    }),
  )
}

function run(a: Args, io: FileIo, apply: boolean): ToolResult {
  const path = fileArg(a)
  if (!path) return err('file（JSON ファイルのパス）を書いてください')
  const c = readCommands(a.commands)
  if (!c.ok) return err(c.error)
  if (c.commands.length === 0) return err('指示が 1 つもありません')
  const l = load(io, path)
  if (!l.ok) return err(l.error)
  const p = findPlan(l.file.set, a.plan)
  if (typeof p === 'string') return err(p)
  const newPlan = a.new_plan
  if (newPlan !== undefined && (typeof newPlan !== 'string' || !newPlan.trim())) return err('new_plan は案の名前（文字列）で書いてください')

  const plan = planAiCommands(p.scene, c.commands)
  if (!plan.ok) return err(`${plan.error}。どの指示も当てていません${apply ? '（ファイルは変えていません）' : ''}`)
  // 画面と同じく、batch コマンド 1 つにまとめて当てる（画面で開けば 1 回の元に戻すで戻る形）
  const r = applyCommand(p.scene, { type: 'batch', commands: plan.steps.map((s) => s.command) })
  if (!r.ok) return err(`${r.error}。どの指示も当てていません`)
  const after = summarizeScene(r.scene)
  const report = {
    plan: { id: p.id, name: p.name },
    steps: plan.steps.map((s) => s.text),
    notices: after.notices,
    metrics: { before: metrics(p.scene), after: metrics(r.scene) },
    nextIds: after.nextIds,
  }
  if (!apply) return ok(json({ ok: true, applied: false, ...report }))

  const w = writeBack(l.file, p, r.scene, typeof newPlan === 'string' ? newPlan.trim() : null)
  if (!w.ok) return err(w.error)
  try {
    io.write(path, w.text)
  } catch (e) {
    return err(`ファイルに書けませんでした: ${path}（${e instanceof Error ? e.message : String(e)}）`)
  }
  return ok(json({ ok: true, applied: true, file: path, ...report, plan: w.plan }))
}

// 当てた後のシーンを案の束に入れて、ファイルの文字列にする
function writeBack(
  file: Loaded,
  source: Plan,
  scene: Scene,
  newPlan: string | null,
): { ok: true; text: string; plan: { id: string; name: string } } | { ok: false; error: string } {
  if (newPlan === null) {
    const set = { ...file.set, plans: file.set.plans.map((q) => (q.id === source.id ? { ...q, scene } : q)) }
    return { ok: true, text: file.single ? serializeScene(scene) : serializePlanSet(set), plan: { id: source.id, name: source.name } }
  }
  // 写しは元の案のすぐ後に置き、ファイルの中で開いている案にする。シーン 1 つのファイルは案の束の形に変わる
  const id = nextPlanIds(file.set)[0]!
  const dup = applyPlanCommand(file.set, { type: 'duplicatePlan', source: source.id, id })
  if (!dup.ok) return dup
  const renamed = applyPlanCommand(dup.set, { type: 'renamePlan', id, name: newPlan })
  if (!renamed.ok) return renamed
  const set = { ...renamed.set, plans: renamed.set.plans.map((q) => (q.id === id ? { ...q, scene } : q)) }
  return { ok: true, text: serializePlanSet(set), plan: { id, name: newPlan } }
}
