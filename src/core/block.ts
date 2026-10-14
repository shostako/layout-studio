// 並べる: 基準の設備（成形機）を、台数・列・向き・取り出し側を決めてユニットごとまとめて置く。DOM に触らない。
// 列は基準の設備を短い辺の向きに積んだ並び（横の成形機なら上下に積む。src/core/layout.ts と同じ）。列は長い辺の向きに並べる。
// 1 台ぶんのユニット（基準の設備＋付帯設備。attach.ts の付ける）を作って大きさを測り、本体の外接の長方形に
// いちばん広い余白を足した間隔で並べる（隣のユニットの本体が余白に入らない）。縦横の混在は、何度か並べて作る。

import { UNIT_RECIPES, attachUnit, type Side } from './attach'
import { applyCommand, type Command } from './commands'
import { createEmptyScene, equipmentBounds, nextEquipmentId, type Rotation, type Scene } from './scene'
import { siteBounds } from './site'
import { equipmentFromTemplate, nextEquipmentName, type EquipmentTemplate } from './templates'
import type { Point } from './viewport'

export type BlockOptions = {
  kind?: string // 基準の設備の種類。省くと、付帯設備の決まりがある最初の基準の種類
  count: number // 台数（1〜100）
  columns?: number // 列の数（省くと 1）
  orientation?: 'horizontal' | 'vertical' // 基準の設備の向き。横＝長い辺が x（省くと横）
  side?: Side // 取り出し側（attach.ts と同じ）
  toward?: Side // 後工程を並べる向き
  origin?: Point // まとまりの本体の左上（省くと、置いてある設備の右か、敷地の左上）
}

export type BlockResult = { ok: true; command: Command; anchors: string[]; note: string } | { ok: false; error: string }

export const MAX_BLOCK = 100

function anchorTemplate(scene: Scene, kind?: string): EquipmentTemplate | string {
  const anchors = scene.templates.filter((t) => t.role === 'anchor')
  if (kind !== undefined) {
    const t = anchors.find((x) => x.kind === kind)
    return t ?? `基準の設備の種類ではありません: ${kind}`
  }
  const t = anchors.find((x) => UNIT_RECIPES.some((r) => r.anchor === x.kind)) ?? anchors[0]
  return t ?? '基準の設備の種類がありません（「設備の種類を編集」で役割を「基準」にする）'
}

const apply = (s: Scene, c: Command): Scene | string => {
  const r = applyCommand(s, c)
  return r.ok ? r.scene : r.error
}

// 基準の設備 1 台を置いて付ける（決まりが無い種類なら基準の設備だけ）。置いた後のシーンとコマンド
function oneUnit(scene: Scene, t: EquipmentTemplate, at: Point, rotation: Rotation, o: BlockOptions): { scene: Scene; commands: Command[]; anchor: string } | string {
  const id = nextEquipmentId(scene)
  const add: Command = { type: 'add', equipment: equipmentFromTemplate(t, { id, name: nextEquipmentName(scene, t), center: at, rotation }) }
  let work = apply(scene, add)
  if (typeof work === 'string') return work
  const commands: Command[] = [add]
  if (UNIT_RECIPES.some((r) => r.anchor === t.kind)) {
    const r = attachUnit(work, id, { side: o.side, toward: o.toward })
    if (!r.ok) return r.error
    if (r.command) {
      const next = apply(work, r.command)
      if (typeof next === 'string') return next
      work = next
      commands.push(r.command)
    }
  }
  return { scene: work, commands, anchor: id }
}

export function placeBlock(scene: Scene, o: BlockOptions): BlockResult {
  const count = o.count
  const columns = o.columns ?? 1
  if (!Number.isInteger(count) || count < 1 || count > MAX_BLOCK) return { ok: false, error: `台数は 1〜${MAX_BLOCK} の整数にしてください` }
  if (!Number.isInteger(columns) || columns < 1 || columns > count) return { ok: false, error: '列の数は 1 から台数までの整数にしてください' }
  const t = anchorTemplate(scene, o.kind)
  if (typeof t === 'string') return { ok: false, error: t }
  const horizontal = (o.orientation ?? 'horizontal') === 'horizontal'
  const rotation: Rotation = horizontal ? 0 : 90

  // 1 台ぶんを原点に作って、本体の外接の長方形といちばん広い余白を測る
  const probe = oneUnit(createEmptyScene(scene.templates), t, { x: 0, y: 0 }, rotation, o)
  if (typeof probe === 'string') return { ok: false, error: probe }
  const box = equipmentBounds(probe.scene.equipment)!
  const gap = Math.max(0, ...probe.scene.equipment.flatMap((e) => [e.clearance.top, e.clearance.right, e.clearance.bottom, e.clearance.left]))
  // 列の中は短い辺の向き（横なら y）に積み、列どうしは長い辺の向き（横なら x）に並べる
  const stack = horizontal ? { x: 0, y: box.height + gap } : { x: box.width + gap, y: 0 }
  const across = horizontal ? { x: box.width + gap, y: 0 } : { x: 0, y: box.height + gap }

  // まとまりの左上: 渡された所 → 置いてある設備の右（上を揃える） → 敷地の左上から 2000 mm 内 → (5000, 5000)
  let origin = o.origin
  if (!origin) {
    const placed = equipmentBounds(scene.equipment)
    const site = scene.site ? siteBounds(scene.site) : null
    origin = placed ? { x: placed.x + placed.width + 3000, y: placed.y } : site ? { x: site.x + 2000, y: site.y + 2000 } : { x: 5000, y: 5000 }
  }
  if (!Number.isFinite(origin.x) || !Number.isFinite(origin.y)) return { ok: false, error: '置く所（x, y）が数ではありません' }
  // 基準の設備の中心 = 左上 − 1 台ぶんの外接の長方形の左上（原点に置いた基準の設備からの位置）
  const first = { x: Math.round(origin.x - box.x), y: Math.round(origin.y - box.y) }

  // 台数を列に分ける。前の列から 1 台ずつ多く（10 台 4 列なら 3・3・2・2）
  const base = Math.floor(count / columns)
  const extra = count % columns
  const sizes = Array.from({ length: columns }, (_, c) => base + (c < extra ? 1 : 0))
  const slots = sizes.flatMap((n, c) => Array.from({ length: n }, (_, k) => ({ c, k })))
  let work = scene
  const commands: Command[] = []
  const anchors: string[] = []
  for (const { c, k } of slots) {
    const at = { x: first.x + c * across.x + k * stack.x, y: first.y + c * across.y + k * stack.y }
    const u = oneUnit(work, t, at, rotation, o)
    if (typeof u === 'string') return { ok: false, error: u }
    work = u.scene
    commands.push(...u.commands)
    anchors.push(u.anchor)
  }
  const used = sizes.filter((n) => n > 0).length
  return {
    ok: true,
    command: { type: 'batch', commands },
    anchors,
    note: `${t.name}を ${count} 台、${horizontal ? '横' : '縦'}向きで ${used} 列に並べる（ユニットの間隔 ${Math.round(horizontal ? stack.y : stack.x)} mm）`,
  }
}
