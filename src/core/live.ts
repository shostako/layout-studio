// 画面へのその場の反映: 手元の MCP サーバーと画面が WebSocket で交わす 1 通の形と、画面が受けた指示の確かめ。DOM に触らない。
// MCP サーバーが頼み（state・apply）を送り、画面が答える。画面は受けた指示を「AI で動かす」と同じ確かめ（planAiCommands）に通し、
// batch コマンド 1 つで当てる（元に戻す 1 回で戻る）。案を選ぶ・写しを作るは案のコマンド（plans.ts）で行う。

import { planAiCommands } from './ai'
import type { Command } from './commands'
import { applyPlanCommand, activePlan, nextPlanIds, type Plan, type PlanCommand, type PlanSet } from './plans'
import { serializePlanSet } from './sceneFile'

// MCP サーバーが待つ既定のポート。変えるときは MCP サーバーを環境変数 LAYOUT_STUDIO_PORT で起動し、画面の欄にも同じ番号を書く
export const LIVE_DEFAULT_PORT = 47615

// MCP サーバー → 画面。state は今の案の束を聞く、apply は指示を当てる
export type LiveAsk = { type: 'state' } | { type: 'apply'; commands: unknown[]; plan?: string; newPlan?: string }
export type LiveRequest = LiveAsk & { id: number }

// 画面 → MCP サーバー。plans は今の案の束（背景の画像は抜いたファイルの形の文字列、liveSnapshot）
export type LiveResponse =
  | { id: number; ok: true; plans: string; applied?: { plan: { id: string; name: string }; steps: string[] } }
  | { id: number; ok: false; error: string }

// 届いた文字列を頼みとして読む。形が違えば null（id が読めれば断りを返せるよう id も返す）
export function parseLiveRequest(text: string): { ok: true; request: LiveRequest } | { ok: false; id: number | null; error: string } {
  let d: unknown
  try {
    d = JSON.parse(text)
  } catch {
    return { ok: false, id: null, error: 'JSON として読めませんでした' }
  }
  if (typeof d !== 'object' || d === null || Array.isArray(d)) return { ok: false, id: null, error: '頼みの形ではありません' }
  const m = d as Record<string, unknown>
  const id = typeof m.id === 'number' && Number.isInteger(m.id) ? m.id : null
  if (id === null) return { ok: false, id: null, error: '頼みに id がありません' }
  if (m.type === 'state') return { ok: true, request: { id, type: 'state' } }
  if (m.type === 'apply') {
    if (!Array.isArray(m.commands)) return { ok: false, id, error: 'commands は指示の配列で書いてください' }
    if (m.plan !== undefined && typeof m.plan !== 'string') return { ok: false, id, error: 'plan は文字列で書いてください' }
    if (m.newPlan !== undefined && (typeof m.newPlan !== 'string' || !m.newPlan.trim()))
      return { ok: false, id, error: 'newPlan は案の名前（文字列）で書いてください' }
    return {
      ok: true,
      request: { id, type: 'apply', commands: m.commands, plan: m.plan as string | undefined, newPlan: (m.newPlan as string | undefined)?.trim() },
    }
  }
  return { ok: false, id, error: `知らない頼みです: ${String(m.type)}` }
}

// 案を id か名前で選ぶ。省くと開いている案。見つからなければ理由の文
export function findPlan(set: PlanSet, key: unknown): Plan | string {
  if (key === undefined || key === null || key === '') return activePlan(set)
  if (typeof key !== 'string') return 'plan は文字列で書いてください'
  const p = set.plans.find((q) => q.id === key) ?? set.plans.find((q) => q.name === key.trim())
  return p ?? `案が見つかりません: ${key}（あるのは ${set.plans.map((q) => `${q.id}「${q.name}」`).join('、')}）`
}

// 画面から MCP サーバーへ送る案の束。背景の画像（data URL）は大きいので、中身を抜いて印だけにする。
// 要約・確かめ・面積には画像の中身は要らない（大きさと縮尺は残す）
export const LIVE_IMAGE_PLACEHOLDER = 'data:,'
export function liveSnapshot(set: PlanSet): string {
  return serializePlanSet({
    ...set,
    plans: set.plans.map((p) =>
      p.scene.background ? { ...p, scene: { ...p.scene, background: { ...p.scene.background, src: LIVE_IMAGE_PLACEHOLDER } } } : p,
    ),
  })
}

// 画面が apply を受けたときにすること: 先に案のコマンド（開く案を切り替える、または写しを作って名前を付ける）を通し、
// その後で開いている案に command（batch）を当てる。確かめは当てる前の案のシーンで済ませる（写しは同じシーンなので結果は同じ）
export type LiveApplyPlan = {
  planCommands: PlanCommand[]
  command: Command
  steps: string[]
  plan: { id: string; name: string }
}

export function planLiveApply(set: PlanSet, req: Extract<LiveRequest, { type: 'apply' }>): { ok: true; plan: LiveApplyPlan } | { ok: false; error: string } {
  if (req.commands.length === 0) return { ok: false, error: '指示が 1 つもありません' }
  const source = findPlan(set, req.plan)
  if (typeof source === 'string') return { ok: false, error: source }
  const checked = planAiCommands(source.scene, req.commands)
  if (!checked.ok) return { ok: false, error: `${checked.error}。どの指示も当てていません` }
  if (checked.steps.length === 0) return { ok: false, error: '変えるものがありません（もう決まりどおりです）。何も当てていません' }
  const command: Command = { type: 'batch', commands: checked.steps.map((s) => s.command) }
  const steps = checked.steps.map((s) => s.text)
  if (!req.newPlan) {
    const planCommands: PlanCommand[] = source.id === set.active ? [] : [{ type: 'switchPlan', id: source.id }]
    return { ok: true, plan: { planCommands, command, steps, plan: { id: source.id, name: source.name } } }
  }
  // 写しを作って名前を付ける。名前が使えるかは当てる前に確かめる（途中で断られて写しだけ残らないように）
  const id = nextPlanIds(set)[0]!
  const planCommands: PlanCommand[] = [
    { type: 'duplicatePlan', source: source.id, id },
    { type: 'renamePlan', id, name: req.newPlan },
  ]
  let s = set
  for (const c of planCommands) {
    const r = applyPlanCommand(s, c)
    if (!r.ok) return { ok: false, error: `${r.error}。どの指示も当てていません` }
    s = r.set
  }
  return { ok: true, plan: { planCommands, command, steps, plan: { id, name: req.newPlan } } }
}
