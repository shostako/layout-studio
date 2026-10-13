// シーンの JSON ファイル: 書き出しと、読み込み（古い版の変換と中身の確かめ）。DOM に触らない。
// ファイルの中身はシーンそのもの（version・background・site・equipment・aisles・links・flow）。形を変えるときは SCENE_VERSION を上げ、
// MIGRATIONS に 1 つ前の版から変換する関数を足す。

import { applyCommand } from './commands'
import { DEFAULT_FLOW_SETTINGS, SCENE_VERSION, createEmptyScene, type Scene } from './scene'
import type { Plan, PlanSet } from './plans'

export type ParseResult = { ok: true; scene: Scene } | { ok: false; error: string }

// MIGRATIONS[n] は版 n のデータを版 n + 1 に変える
export const MIGRATIONS: Record<number, (data: Record<string, unknown>) => Record<string, unknown>> = {
  // 版 2 で敷地の外形を足した。版 1 には無いので null
  1: (d) => ({ ...d, site: null }),
  // 版 3 で AGV の通路を足した。版 2 には無いので空
  2: (d) => ({ ...d, aisles: [] }),
  // 版 4 で設備の保守用の余白を足した。版 3 には無いので 0
  3: (d) => ({
    ...d,
    equipment: Array.isArray(d.equipment)
      ? d.equipment.map((e: unknown) =>
          typeof e === 'object' && e !== null ? { ...e, clearance: { top: 0, right: 0, bottom: 0, left: 0 } } : e,
        )
      : d.equipment,
  }),
  // 版 5 で工程のつなぎを足した。版 4 には無いので空
  4: (d) => ({ ...d, links: [] }),
  // 版 6 で流れの再生の数値を足した。版 5 は架空の目安（それまで固定だった値）で読む
  5: (d) => ({ ...d, flow: { ...DEFAULT_FLOW_SETTINGS } }),
  // 版 7 で通路の一方通行（oneWay）を足した。版 6 の通路はどれも両方向なので、そのまま読む
  6: (d) => d,
}

export function serializeScene(scene: Scene): string {
  return JSON.stringify(scene, null, 2) + '\n'
}

// 版を今の版まで上げる。新しすぎる版と、版の無いものは断る
export function migrate(
  data: unknown,
  migrations = MIGRATIONS,
  current = SCENE_VERSION as number,
): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
  if (typeof data !== 'object' || data === null || Array.isArray(data))
    return { ok: false, error: 'layout-studio のシーンのファイルではありません' }
  let d = data as Record<string, unknown>
  let v = d.version
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1)
    return { ok: false, error: 'ファイルに版（version）がありません。layout-studio のシーンのファイルではないようです' }
  if (v > current) return { ok: false, error: `新しい版（${v}）のファイルです。アプリを新しくしてください（読めるのは版 ${current} まで）` }
  while (v < current) {
    const step = migrations[v]
    if (!step) return { ok: false, error: `版 ${v} から変換できません` }
    d = { ...step(d), version: v + 1 }
    v += 1
  }
  return { ok: true, data: d }
}

export function parseScene(text: string): ParseResult {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { ok: false, error: 'JSON として読めませんでした' }
  }
  return parseSceneData(data)
}

// JSON.parse した後のシーンを読む（版を上げて、中身を確かめる）
function parseSceneData(data: unknown): ParseResult {
  const m = migrate(data)
  if (!m.ok) return m
  // 中身の確かめは、シーンを差し替えるコマンドと同じものを使う
  const r = applyCommand(createEmptyScene(), { type: 'loadScene', scene: m.data as unknown as Scene })
  return r.ok ? { ok: true, scene: r.scene } : { ok: false, error: r.error }
}

// 保存するファイルの名前（layout-20261013-1530.json）
export function sceneFileName(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `layout-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.json`
}

// ---- 案の束のファイル ----
// 案を複数入れたファイルは { format: PLAN_FILE_FORMAT, version, active, plans: [{ id, name, scene }] }。
// scene はシーンのファイルと同じ形（自分の version を持つ）で、読むときはシーンのファイルと同じ変換と確かめを通す。
// 束の形を変えるときは PLAN_FILE_VERSION を上げる。
export const PLAN_FILE_FORMAT = 'layout-studio/plans'
export const PLAN_FILE_VERSION = 1

export type PlanFileResult = { ok: true; plans: Plan[]; active: string } | { ok: false; error: string }

export function serializePlanSet(set: PlanSet): string {
  const data = { format: PLAN_FILE_FORMAT, version: PLAN_FILE_VERSION, active: set.active, plans: set.plans }
  return JSON.stringify(data, null, 2) + '\n'
}

// 案の束のファイルを読む。シーン 1 つだけのファイル（案の束より前の形）は、name の案 1 つとして読む
export function parsePlanFile(text: string, name: string): PlanFileResult {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { ok: false, error: 'JSON として読めませんでした' }
  }
  const d = data as Record<string, unknown> | null
  if (typeof d !== 'object' || d === null || Array.isArray(d) || d.format !== PLAN_FILE_FORMAT) {
    const r = parseSceneData(data)
    return r.ok ? { ok: true, plans: [{ id: 'plan-1', name, scene: r.scene }], active: 'plan-1' } : r
  }
  const v = d.version
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) return { ok: false, error: 'ファイルに版（version）がありません' }
  if (v > PLAN_FILE_VERSION)
    return { ok: false, error: `新しい版（${v}）のファイルです。アプリを新しくしてください（読めるのは版 ${PLAN_FILE_VERSION} まで）` }
  if (!Array.isArray(d.plans) || d.plans.length === 0) return { ok: false, error: '案の一覧（plans）がありません' }
  const plans: Plan[] = []
  for (const [i, p] of (d.plans as unknown[]).entries()) {
    const where = `${i + 1} 番目の案`
    if (typeof p !== 'object' || p === null) return { ok: false, error: `${where}が案の形ではありません` }
    const { id, name: n, scene } = p as Record<string, unknown>
    if (typeof id !== 'string' || !id) return { ok: false, error: `${where}の id がありません` }
    if (plans.some((q) => q.id === id)) return { ok: false, error: `案の id が重複しています: ${id}` }
    if (typeof n !== 'string' || !n.trim()) return { ok: false, error: `${where}の名前がありません` }
    if (plans.some((q) => q.name === n.trim())) return { ok: false, error: `同じ名前の案があります: ${n.trim()}` }
    const r = parseSceneData(scene)
    if (!r.ok) return { ok: false, error: `案「${n.trim()}」: ${r.error}` }
    plans.push({ id, name: n.trim(), scene: r.scene })
  }
  // 開いていた案が見つからなければ先頭を開く
  const active = typeof d.active === 'string' && plans.some((p) => p.id === d.active) ? d.active : plans[0]!.id
  return { ok: true, plans, active }
}
