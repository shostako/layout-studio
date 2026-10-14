// ユニット: 基準の設備（役割が anchor。射出成形の組では成形機）1 台と、それに付く付帯設備のまとまり。DOM に触らない。
// 付帯設備は、つなぎを基準の設備から下流へたどって着く設備（ほかの基準の設備の手前で止める）と、
// 基準の設備に載る設備（役割が mounted で載り先が基準の種類。つなぎの向きはどちらでもよい）。
// 2 台以上の基準の設備から着く設備（共有の列など）は、どのユニットにも入れない（片方を動かしたときに引きずらないため）。

import type { Command } from './commands'
import { roleOf } from './templates'
import type { Equipment, Scene } from './scene'

export function isAnchor(scene: Scene, eq: Equipment): boolean {
  return roleOf(scene, eq.kind) === 'anchor'
}

// 基準の設備 1 台から着く設備（自分は入れない）。共有かどうかは見ない
function reach(scene: Scene, anchor: Equipment): Set<string> {
  const byId = new Map(scene.equipment.map((e) => [e.id, e]))
  const out = new Set<string>()
  const stack = [anchor.id]
  while (stack.length) {
    const id = stack.pop()!
    for (const l of scene.links) {
      if (l.from !== id || out.has(l.to) || l.to === anchor.id) continue
      const next = byId.get(l.to)
      if (!next || isAnchor(scene, next)) continue
      out.add(l.to)
      stack.push(l.to)
    }
  }
  // 載る設備は、つなぎが逆向き（載る設備 → 基準）でも入れる
  for (const l of scene.links) {
    const other = l.to === anchor.id ? l.from : l.from === anchor.id ? l.to : null
    if (other === null || out.has(other)) continue
    const eq = byId.get(other)
    if (!eq) continue
    const t = scene.templates.find((x) => x.kind === eq.kind)
    if (t?.role === 'mounted' && t.mountsOn === anchor.kind) out.add(other)
  }
  return out
}

// 基準の設備ごとのユニットの付帯設備（id の並びはシーンの設備の並び）。基準の設備でない id には空を返す
export function unitsOf(scene: Scene): Map<string, string[]> {
  const anchors = scene.equipment.filter((e) => isAnchor(scene, e))
  const reached = new Map(anchors.map((a) => [a.id, reach(scene, a)]))
  const count = new Map<string, number>()
  for (const set of reached.values()) for (const id of set) count.set(id, (count.get(id) ?? 0) + 1)
  const out = new Map<string, string[]>()
  for (const a of anchors) {
    const set = reached.get(a.id)!
    out.set(
      a.id,
      scene.equipment.filter((e) => set.has(e.id) && count.get(e.id) === 1).map((e) => e.id),
    )
  }
  return out
}

export function unitMembers(scene: Scene, anchorId: string): string[] {
  return unitsOf(scene).get(anchorId) ?? []
}

// 選んだ設備に、選んだ基準の設備のユニットの付帯設備を足す（選んだ順の後ろに、重ねずに）
export function withUnits(scene: Scene, ids: readonly string[]): string[] {
  const units = unitsOf(scene)
  const out = [...ids]
  const seen = new Set(ids)
  for (const id of ids)
    for (const m of units.get(id) ?? [])
      if (!seen.has(m)) {
        seen.add(m)
        out.push(m)
      }
  return out
}

// 選んだ設備を回すコマンド。基準の設備は、ユニットごとその中心のまわりに回す（付帯設備も位置と向きが一緒に回る）。
// ほかの設備（どのユニットにも入らないもの）は、それぞれの中心のまわりに回す。選んだ付帯設備は、その基準の設備も選んでいればユニットと一緒に回る
export function rotateWithUnits(scene: Scene, ids: readonly string[], quarterTurns: number): Command | null {
  const units = unitsOf(scene)
  const commands: Command[] = []
  const covered = new Set<string>()
  for (const id of ids) {
    const members = units.get(id)
    const anchor = scene.equipment.find((e) => e.id === id)
    if (!members || !anchor) continue
    const group = [id, ...members.filter((m) => !covered.has(m))]
    for (const m of group) covered.add(m)
    commands.push({ type: 'rotateAbout', ids: group, quarterTurns, pivot: { x: anchor.x, y: anchor.y } })
  }
  const rest = ids.filter((id) => !covered.has(id))
  if (rest.length) commands.push({ type: 'rotate', ids: rest, quarterTurns })
  if (commands.length === 0) return null
  return commands.length === 1 ? commands[0]! : { type: 'batch', commands }
}
