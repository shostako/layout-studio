// シーン（図面・設備）の型。DOM に触らない。単位は mm、原点は図面の左上、右が x、下が y。

import type { Aisle } from './aisle'
import type { Background } from './background'
import type { Link } from './flow'
import type { Site } from './site'
import { INJECTION_PRESET, copyTemplates, type EquipmentTemplate } from './templates'

// 版 2 で敷地の外形（site）、版 3 で AGV の通路（aisles）、版 4 で設備の保守用の余白（clearance）、
// 版 5 で工程のつなぎ（links）、版 6 で流れの再生の数値（flow）、版 7 で通路の一方通行（oneWay）、
// 版 8 で AGV の台数（flow.agvCount）、版 9 で設備の種類の一覧（templates）を足した
export const SCENE_VERSION = 9

export type Rotation = 0 | 90 | 180 | 270

// 保守用の余白（mm）。回転 0 のときの上・右・下・左の辺から外へ取る幅。設備と一緒に回る
export type Clearance = { top: number; right: number; bottom: number; left: number }

// 流れの再生の数値。案ごとに持ち、保存する（案件ごとにサイクルや台車の大きさが違うため）
export type FlowSettings = {
  cycleTime: number // 成形のサイクル時間（秒）
  stockerCapacity: number // ストッカー 1 台に入る数（満杯の数）
  agvSpeed: number // AGV の速さ（mm/秒）
  agvHandlingTime: number // AGV がストッカーで台車を替える時間（秒）
  agvCount: number // AGV の台数
}

// 最初の値は架空の目安
export const DEFAULT_FLOW_SETTINGS: FlowSettings = {
  cycleTime: 30,
  stockerCapacity: 20,
  agvSpeed: 1000,
  agvHandlingTime: 30,
  agvCount: 1,
}

// 受け付ける範囲（下限と上限を含む）。サイクルの下限は、再生の刻み（0.25 秒）で数え落とさず、
// 成形品が増えすぎて画面が重くならないように 1 秒にした。容量は整数
export const FLOW_LIMITS: Record<keyof FlowSettings, { min: number; max: number; integer?: boolean; label: string }> = {
  cycleTime: { min: 1, max: 3600, label: 'サイクル時間（秒）' },
  stockerCapacity: { min: 1, max: 10000, integer: true, label: 'ストッカーの容量（個）' },
  agvSpeed: { min: 10, max: 10000, label: 'AGV の速さ（mm/秒）' },
  agvHandlingTime: { min: 0, max: 3600, label: '台車の入れ替えの時間（秒）' },
  agvCount: { min: 1, max: 20, integer: true, label: 'AGV の台数' },
}

export const NO_CLEARANCE: Clearance = { top: 0, right: 0, bottom: 0, left: 0 }

export type Equipment = {
  id: string
  kind: string // 'molding-machine' など。ひな形（scene.templates）の種類
  name: string
  // 設備の中心の座標。回転は中心のまわりで行うので、回しても x, y は変わらない
  x: number
  y: number
  width: number // 回転 0 のときの x 方向の長さ
  depth: number // 回転 0 のときの y 方向の長さ
  rotation: Rotation // 時計回り（画面の見た目で）
  color: string
  clearance: Clearance
}

export type Scene = {
  version: typeof SCENE_VERSION
  background: Background | null // 建物の図面の画像。無ければ null
  site: Site | null // 敷地の外形。無ければ null
  equipment: Equipment[]
  aisles: Aisle[] // AGV の通路
  links: Link[] // 工程のつなぎ（設備から設備へ、ものが流れる向き）
  flow: FlowSettings // 流れの再生の数値
  templates: EquipmentTemplate[] // 設備の種類（ひな形）の一覧。並びは工程の順
}

// 空のシーン。ひな形を渡さなければ射出成形の組
export function createEmptyScene(templates: readonly EquipmentTemplate[] = INJECTION_PRESET): Scene {
  return {
    version: SCENE_VERSION,
    background: null,
    site: null,
    equipment: [],
    aisles: [],
    links: [],
    flow: { ...DEFAULT_FLOW_SETTINGS },
    templates: copyTemplates(templates),
  }
}

// 回転を考えた、図面の上で占める外接の長方形（左上と大きさ）
export function footprint(eq: Equipment): { x: number; y: number; width: number; height: number } {
  const turned = eq.rotation === 90 || eq.rotation === 270
  const width = turned ? eq.depth : eq.width
  const height = turned ? eq.width : eq.depth
  return { x: eq.x - width / 2, y: eq.y - height / 2, width, height }
}

// 余白を図面の向き（回転を考えた上・右・下・左）にしたもの。時計回りに 90 度回すと、上の余白が右へ移る
export function worldClearance(eq: Equipment): Clearance {
  const c = eq.clearance
  const sides = [c.top, c.right, c.bottom, c.left]
  const k = eq.rotation / 90
  const at = (i: number) => sides[(i - k + 4) % 4]!
  return { top: at(0), right: at(1), bottom: at(2), left: at(3) }
}

// 余白まで含めた長方形（外接の長方形を余白の幅だけ広げたもの）
export function clearanceRect(eq: Equipment): { x: number; y: number; width: number; height: number } {
  const f = footprint(eq)
  const c = worldClearance(eq)
  return { x: f.x - c.left, y: f.y - c.top, width: f.width + c.left + c.right, height: f.height + c.top + c.bottom }
}

// まだ使われていない設備の id を返す（'eq-1', 'eq-2', ...）。コマンドは id を受け取る側にし、純関数のままにする
export function nextEquipmentId(scene: Scene): string {
  let max = 0
  for (const eq of scene.equipment) {
    const m = /^eq-(\d+)$/.exec(eq.id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `eq-${max + 1}`
}

// まだ使われていない設備の id を n 個（複製で使う）
export function nextEquipmentIds(scene: Scene, n: number): string[] {
  const first = Number(nextEquipmentId(scene).slice(3))
  return Array.from({ length: n }, (_, i) => `eq-${first + i}`)
}

// 写しの名前。「成形機 2」を写すと、同じ「成形機 n」の番号の続き（「成形機 3」など）にする。
// 番号の無い名前は、その名前を 1 番とみなして「名前 2」から振る
export function duplicateName(scene: Scene, name: string): string {
  const m = /^(.*\S) (\d+)$/.exec(name)
  const base = m ? m[1]! : name
  let max = 0
  for (const eq of scene.equipment) {
    if (eq.name === base) max = Math.max(max, 1)
    const k = /^(.*\S) (\d+)$/.exec(eq.name)
    if (k && k[1] === base) max = Math.max(max, Number(k[2]))
  }
  return `${base} ${max + 1}`
}

// 設備をまとめて囲む長方形（回転を考えた外接の長方形の和）。無ければ null
export function equipmentBounds(items: readonly Equipment[]): { x: number; y: number; width: number; height: number } | null {
  if (items.length === 0) return null
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const eq of items) {
    const f = footprint(eq)
    x0 = Math.min(x0, f.x)
    y0 = Math.min(y0, f.y)
    x1 = Math.max(x1, f.x + f.width)
    y1 = Math.max(y1, f.y + f.height)
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}
