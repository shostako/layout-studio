// 設備の種類（ひな形）。寸法は架空の目安で、置くときに変えて使う。DOM に触らない。
// ひな形の一覧は案ごとにシーンが持ち（scene.templates）、画面や AI から足す・変える・消す（setTemplates コマンド）。
// 一覧の並びは工程の順。種類ごとの振る舞いは種類の名前ではなく「役割」で決める（DECISIONS.md 2026-10-14）。

import type { Point } from './viewport'
import type { Clearance, Equipment, Rotation, Scene } from './scene'

// 役割: anchor＝基準（レイアウトの骨組み。射出成形の組では成形機）、mounted＝載る（mountsOn の種類の上に重ねて置く）、
// buffer＝溜める（満杯で AGV を呼ぶ。流れの再生でストッカーとして扱う）。役割の無い種類は、ふつうの設備
export type Role = 'anchor' | 'mounted' | 'buffer'
export const ROLES: readonly Role[] = ['anchor', 'mounted', 'buffer']
export const ROLE_LABELS: Record<Role, string> = { anchor: '基準', mounted: '載る', buffer: '溜める' }

export type EquipmentTemplate = {
  kind: string // 種類の名札（英数字と - の短い文字列）。置いた設備の kind と結び付く
  name: string
  width: number // mm。回転 0 のときの x 方向
  depth: number // mm。回転 0 のときの y 方向
  color: string
  clearance: Clearance // 保守用の余白の最初の値（mm）
  role?: Role
  mountsOn?: string // role が mounted のとき、載り先の種類
}

const around = (mm: number): Clearance => ({ top: mm, right: mm, bottom: mm, left: mm })

// 射出成形の組（プリセット）。工程の順に並べる。寸法と余白は架空の目安（実機の値ではない）。
// 成形機は横長（x が型締めの向き）。取出機は成形機の上に載る横走行形で、走行の梁が成形機を横切る（y が梁の向き）。
// 成形機の中心から梁は反操作側へ約 800、操作側へ約 2800 張り出し、操作側に成形品を落とす（DECISIONS.md）
export const INJECTION_PRESET: readonly EquipmentTemplate[] = [
  { kind: 'molding-machine', name: '成形機', width: 10000, depth: 2800, color: '#5b8bd9', clearance: around(1000), role: 'anchor' },
  { kind: 'take-out-robot', name: '取出機', width: 800, depth: 3600, color: '#4fae8a', clearance: around(500), role: 'mounted', mountsOn: 'molding-machine' },
  { kind: 'degating-machine', name: '型抜き機', width: 1500, depth: 1500, color: '#d9a44a', clearance: around(500) },
  { kind: 'trimming-machine', name: 'トリミング機', width: 1800, depth: 1200, color: '#c97a5b', clearance: around(500) },
  { kind: 'weighing-scale', name: '重量計', width: 800, depth: 600, color: '#9a7fc9', clearance: around(500) },
  { kind: 'cart-stocker', name: '台車ストッカー', width: 1200, depth: 1000, color: '#7f8a99', clearance: around(500), role: 'buffer' },
]

// 組の一覧（画面の「組を足す」）。ほかの業種の組は、ここに足す
export const PRESETS: readonly { id: string; name: string; templates: readonly EquipmentTemplate[] }[] = [
  { id: 'injection', name: '射出成形', templates: INJECTION_PRESET },
]

// 写し（シーンに入れる一覧は、組の値と共有しない）
export function copyTemplates(list: readonly EquipmentTemplate[]): EquipmentTemplate[] {
  return list.map((t) => ({ ...t, clearance: { ...t.clearance } }))
}

export function findTemplate(templates: readonly EquipmentTemplate[], kind: string): EquipmentTemplate | undefined {
  return templates.find((t) => t.kind === kind)
}

// 設備の種類の役割（ひな形に無い種類と、役割の無い種類は undefined）
export function roleOf(scene: Scene, kind: string): Role | undefined {
  return findTemplate(scene.templates, kind)?.role
}

const KIND_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const COLOR_RE = /^#[0-9a-fA-F]{6}$/

// ひな形の一覧を確かめる。理由つきで断る（null なら問題なし）
export function checkTemplates(list: unknown): string | null {
  if (!Array.isArray(list)) return 'ひな形の一覧（templates）が配列ではありません'
  if (list.length > 100) return 'ひな形は 100 種類までです'
  const kinds = new Set<string>()
  const names = new Set<string>()
  for (const [i, t] of list.entries()) {
    const where = `${i + 1} 番目のひな形`
    if (typeof t !== 'object' || t === null || Array.isArray(t)) return `${where}がひな形の形ではありません`
    const r = t as Record<string, unknown>
    if (typeof r.kind !== 'string' || !KIND_RE.test(r.kind)) return `${where}の kind は英小文字・数字・- の 64 字以内にしてください`
    if (kinds.has(r.kind)) return `ひな形の種類（kind）が重複しています: ${r.kind}`
    kinds.add(r.kind)
    if (typeof r.name !== 'string' || !r.name.trim()) return `${where}（${r.kind}）の名前がありません`
    if (names.has(r.name.trim())) return `同じ名前のひな形があります: ${r.name.trim()}`
    names.add(r.name.trim())
    for (const k of ['width', 'depth'] as const) {
      const v = r[k]
      if (!(typeof v === 'number' && v > 0 && Number.isFinite(v))) return `${where}（${r.name}）の幅と奥行は正の数にしてください`
    }
    if (typeof r.color !== 'string' || !COLOR_RE.test(r.color)) return `${where}（${r.name}）の色は #rrggbb にしてください`
    const c = r.clearance as Record<string, unknown> | null
    if (typeof c !== 'object' || c === null || Array.isArray(c)) return `${where}（${r.name}）の余白（clearance）がありません`
    for (const k of ['top', 'right', 'bottom', 'left'])
      if (!(typeof c[k] === 'number' && (c[k] as number) >= 0 && Number.isFinite(c[k] as number)))
        return `${where}（${r.name}）の余白は上・右・下・左とも 0 以上の数にしてください`
    if (r.role !== undefined && !ROLES.includes(r.role as Role)) return `${where}（${r.name}）の役割は ${ROLES.join('・')} のどれかです`
    if (r.role === 'mounted') {
      if (typeof r.mountsOn !== 'string' || !r.mountsOn) return `${where}（${r.name}）は「載る」なので、載り先の種類（mountsOn）が要ります`
      if (r.mountsOn === r.kind) return `${where}（${r.name}）は自分の種類には載れません`
    } else if (r.mountsOn !== undefined) return `${where}（${r.name}）の載り先（mountsOn）は役割が「載る」のときだけ書けます`
  }
  for (const t of list as Record<string, unknown>[])
    if (t.role === 'mounted' && !kinds.has(t.mountsOn as string)) return `${String(t.name)}の載り先の種類がひな形にありません: ${String(t.mountsOn)}`
  return null
}

// 確かめた一覧を、決まった項目だけの形に揃える（余分な項目を落とし、名前の前後の空白を取る）
export function normalizeTemplates(list: readonly EquipmentTemplate[]): EquipmentTemplate[] {
  return list.map((t) => {
    const { top, right, bottom, left } = t.clearance
    const out: EquipmentTemplate = { kind: t.kind, name: t.name.trim(), width: t.width, depth: t.depth, color: t.color, clearance: { top, right, bottom, left } }
    if (t.role) out.role = t.role
    if (t.role === 'mounted') out.mountsOn = t.mountsOn
    return out
  })
}

// まだ使われていない種類の名札（'custom-1', 'custom-2', ...）
export function nextTemplateKind(templates: readonly EquipmentTemplate[]): string {
  let n = 1
  while (templates.some((t) => t.kind === `custom-${n}`)) n++
  return `custom-${n}`
}

// 組を一覧に足す。もうある種類は今の値のまま残し、無い種類だけを後ろに足す
export function mergePreset(templates: readonly EquipmentTemplate[], preset: readonly EquipmentTemplate[]): EquipmentTemplate[] {
  const names = new Set(templates.map((t) => t.name))
  const add = preset.filter((p) => !templates.some((t) => t.kind === p.kind))
  // 名前だけ重なるときは（組の）を付けて足す
  return [...copyTemplates(templates), ...copyTemplates(add).map((t) => (names.has(t.name) ? { ...t, name: `${t.name}（組）` } : t))]
}

// 同じ種類の名前の番号の続き（「成形機 1」「成形機 2」…）。消した番号は詰めない
export function nextEquipmentName(scene: Scene, t: EquipmentTemplate): string {
  let max = 0
  const prefix = `${t.name} `
  for (const eq of scene.equipment) {
    if (eq.kind !== t.kind || !eq.name.startsWith(prefix)) continue
    const n = Number(eq.name.slice(prefix.length))
    if (Number.isInteger(n) && n > max) max = n
  }
  return `${t.name} ${max + 1}`
}

export type PlaceOptions = {
  id: string
  name: string
  center: Point
  width?: number // 省略するとひな形の寸法
  depth?: number
  rotation?: Rotation
}

// ひな形から、置く設備を作る。add コマンドに渡す
export function equipmentFromTemplate(t: EquipmentTemplate, o: PlaceOptions): Equipment {
  return {
    id: o.id,
    kind: t.kind,
    name: o.name,
    x: o.center.x,
    y: o.center.y,
    width: o.width ?? t.width,
    depth: o.depth ?? t.depth,
    rotation: o.rotation ?? 0,
    color: t.color,
    clearance: { ...t.clearance },
  }
}
