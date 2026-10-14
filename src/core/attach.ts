// 付帯設備を付ける・整える（docs/layout-rules.md の計算）。DOM に触らない。
// 付ける: 基準の設備 1 台に、組の決まり（UNIT_RECIPES）どおりの付帯設備を置いてつなぐ。ユニットに同じ種類があれば、それを動かして使う。
// 整える: ユニットの付帯設備の並びの順と向きを保ったまま、間隔を余白ちょうどに揃え、列の線に揃える。載る設備と基準の設備は動かさない。
// どちらも、当てるコマンド（batch）を返す。画面のボタン・AI の指示（attachUnit・arrangeUnits）が同じ計算を通る。

import type { Command } from './commands'
import { footprint, nextEquipmentId, worldClearance, type Clearance, type Equipment, type Rotation, type Scene } from './scene'
import { equipmentFromTemplate, findTemplate, nextEquipmentName } from './templates'
import { unitsOf } from './unit'
import type { Point } from './viewport'

// 組ごとのユニットの決まり。基準の設備の種類で引く
export type UnitRecipe = {
  anchor: string
  // 載る設備。基準の設備の長い辺に沿って中心から alongRatio × 長さだけ、後工程と反対の側へずらし、
  // 梁（奥行）を短い辺の向きに、取り出し側と反対へ back mm だけ張り出す（残りは取り出し側へ）
  mounted?: { kind: string; alongRatio: number; back: number }
  chain: string[] // 載る設備の次から、取り出し側の長い辺に沿って並べる種類（工程の順）
  buffers: string[] // 列の最後に並べる溜める設備（ストッカーと予備）。どれも chain の最後からつなぐ
}

// 射出成形の組。寸法の目安は DECISIONS.md（取出機の梁は反操作側へ約 800、操作側へ約 2800）
export const UNIT_RECIPES: readonly UnitRecipe[] = [
  {
    anchor: 'molding-machine',
    mounted: { kind: 'take-out-robot', alongRatio: 0.15, back: 800 },
    chain: ['degating-machine', 'trimming-machine'],
    buffers: ['cart-stocker', 'cart-stocker'],
  },
]

export type Side = 'top' | 'bottom' | 'left' | 'right'
// 付けるときの向き。side は取り出し側（基準の設備の長い辺のどちら）、toward は後工程を並べていく向き（長い辺に沿うどちら）
export type AttachOptions = { side?: Side; toward?: Side }

export type AttachResult = { ok: true; command: Command | null; note: string } | { ok: false; error: string }

const VEC: Record<Side, Point> = { top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } }
const SIDE_NAME: Record<Side, string> = { top: '上', bottom: '下', left: '左', right: '右' }
const sideOf = (v: Point): Side => (v.x > 0 ? 'right' : v.x < 0 ? 'left' : v.y > 0 ? 'bottom' : 'top')
const opposite = (s: Side): Side => sideOf({ x: -VEC[s].x, y: -VEC[s].y })

// 基準の設備の向き: 横（長い辺が x に沿う）か縦か
function isHorizontal(eq: Equipment): boolean {
  const f = footprint(eq)
  return f.width >= f.height
}

// 図面の向きの余白から、ある向きの辺の値
const clearanceToward = (c: Clearance, s: Side) => c[s]

// 中心から、ある向きの外形の端までの長さ
function half(eq: Equipment, s: Side): number {
  const f = footprint(eq)
  return VEC[s].x !== 0 ? f.width / 2 : f.height / 2
}

const dot = (p: Point, v: Point) => p.x * v.x + p.y * v.y
const round = (v: number) => Math.round(v)

type Frame = { anchor: Equipment; side: Side; toward: Side }

// 取り出し側と並べる向きを決める（docs/layout-rules.md「取り出し側」）。渡された向きが基準の設備の向きに合わなければ断る
// ユニットの中の同じ種類の設備を、つなぎの順（先につないだものから）に並べる。つないでいないものは後ろ（シーンの並び順）
function byLinkOrder(scene: Scene, anchor: Equipment, members: Equipment[], kind: string): Equipment[] {
  const order = (id: string) => {
    const i = scene.links.findIndex((l) => l.to === id || (l.from === id && l.to === anchor.id))
    return i < 0 ? Infinity : i
  }
  return members.filter((x) => x.kind === kind).sort((a, b) => order(a.id) - order(b.id))
}

// 決まりの載る設備のうち、使う 1 台（つなぎの順で先のもの）。向きの推定と付け直しで同じものを使う
function mountedOf(scene: Scene, anchor: Equipment, members: Equipment[], recipe: UnitRecipe | undefined): Equipment | undefined {
  return recipe?.mounted ? byLinkOrder(scene, anchor, members, recipe.mounted.kind)[0] : undefined
}

function frameFor(scene: Scene, anchor: Equipment, members: Equipment[], recipe: UnitRecipe | undefined, o: AttachOptions): Frame | string {
  const horizontal = isHorizontal(anchor)
  const across: Side[] = horizontal ? ['top', 'bottom'] : ['left', 'right']
  const along: Side[] = horizontal ? ['left', 'right'] : ['top', 'bottom']
  const c = { x: anchor.x, y: anchor.y }
  if (o.side !== undefined && !across.includes(o.side))
    return `${anchor.name}は${horizontal ? '横' : '縦'}向きなので、取り出し側は${across.map((s) => SIDE_NAME[s]).join('か')}です`
  if (o.toward !== undefined && !along.includes(o.toward))
    return `${anchor.name}は${horizontal ? '横' : '縦'}向きなので、並べる向きは${along.map((s) => SIDE_NAME[s]).join('か')}です`
  const robot = mountedOf(scene, anchor, members, recipe)
  // 後工程は、載る設備（どれも）を除いたもの
  const rest = members.filter((m) => !(recipe?.mounted && m.kind === recipe.mounted.kind))
  const mean = (list: Equipment[], v: Point) => list.reduce((a, m) => a + dot({ x: m.x - c.x, y: m.y - c.y }, v), 0) / Math.max(1, list.length)
  // 取り出し側: 渡された側 → 載る設備が張り出している側 → 後工程がある側 → 横は下・縦は右
  let side = o.side
  if (!side && robot && Math.abs(mean([robot], VEC[across[1]!])) > 1) side = mean([robot], VEC[across[1]!]) > 0 ? across[1]! : across[0]!
  if (!side && rest.length && Math.abs(mean(rest, VEC[across[1]!])) > 1) side = mean(rest, VEC[across[1]!]) > 0 ? across[1]! : across[0]!
  side ??= across[1]!
  // 並べる向き: 渡された向き → 載る設備と反対の側 → 後工程がある側 → 横は左・縦は上
  let toward = o.toward
  if (!toward && robot && Math.abs(mean([robot], VEC[along[1]!])) > 1) toward = mean([robot], VEC[along[1]!]) > 0 ? along[0]! : along[1]!
  if (!toward && rest.length && Math.abs(mean(rest, VEC[along[1]!])) > 1) toward = mean(rest, VEC[along[1]!]) > 0 ? along[1]! : along[0]!
  toward ??= along[0]!
  return { anchor, side, toward }
}

// 並べる設備の位置（中心）を決める。row は工程の順、start は最初の設備の手前の端（並べる向きの座標）
function layRow(frame: Frame, row: Equipment[], start: { at: number; clearance: number }): Map<string, Point> {
  const { anchor, side, toward } = frame
  const s = VEC[side]
  const t = VEC[toward]
  const ac = worldClearance(anchor)
  // 列の線: 基準の設備の取り出し側の辺から、余白の大きい方だけ離し、いちばん奥行のある設備の中心に揃える
  const gapV = Math.max(clearanceToward(ac, side), ...row.map((m) => clearanceToward(worldClearance(m), opposite(side))))
  const depth = Math.max(...row.map((m) => half(m, side)))
  const line = dot({ x: anchor.x, y: anchor.y }, s) + half(anchor, side) + gapV + depth
  const out = new Map<string, Point>()
  let edge = start.at
  let prevClearance = start.clearance
  for (const m of row) {
    const c = worldClearance(m)
    const gap = Math.max(prevClearance, clearanceToward(c, opposite(toward)))
    const along = edge + gap + half(m, toward)
    // 並べる向きの座標 along と、列の線 line から中心を作る（s と t は直交する軸の単位ベクトル）
    out.set(m.id, { x: round(t.x * along + s.x * line), y: round(t.y * along + s.y * line) })
    edge = along + half(m, toward)
    prevClearance = clearanceToward(c, toward)
  }
  return out
}

// 列の始まり: 載る設備があれば、その並べる向きの端（と余白）。無ければ基準の設備の中心から少し戻った所
function rowStart(frame: Frame, robot: Equipment | null): { at: number; clearance: number } {
  const t = VEC[frame.toward]
  if (robot) return { at: dot({ x: robot.x, y: robot.y }, t) + half(robot, frame.toward), clearance: clearanceToward(worldClearance(robot), frame.toward) }
  // 載る設備の無い組: 基準の設備の後ろの端から並べる
  return { at: dot({ x: frame.anchor.x, y: frame.anchor.y }, t) - half(frame.anchor, frame.toward), clearance: 0 }
}

// 載る設備の位置: 基準の中心から、並べる向きと反対へ alongRatio × 長さ、取り出し側へ（奥行の半分 − back）
function robotPlace(frame: Frame, recipe: UnitRecipe, robot: Equipment): Point {
  const { anchor, side, toward } = frame
  const m = recipe.mounted!
  const length = 2 * half(anchor, toward)
  const s = VEC[side]
  const t = VEC[toward]
  const out = -m.alongRatio * length
  const across = half(robot, side) - m.back
  return { x: round(anchor.x + t.x * out + s.x * across), y: round(anchor.y + t.y * out + s.y * across) }
}

// 種類の向き: 横の基準なら 0、縦なら 90（ユニットごと 90 度回した形）
const rotationFor = (anchor: Equipment): Rotation => (isHorizontal(anchor) ? 0 : 90)

// 付帯設備の決まりがある基準の設備か（「全部を整える」は、決まりのある基準の設備だけにする）
export function hasRecipe(anchor: Equipment): boolean {
  return UNIT_RECIPES.some((r) => r.anchor === anchor.kind)
}

function recipeFor(scene: Scene, anchor: Equipment): UnitRecipe | undefined {
  return UNIT_RECIPES.find((r) => r.anchor === anchor.kind)
}

// 付ける
export function attachUnit(scene: Scene, anchorId: string, o: AttachOptions = {}): AttachResult {
  const anchor = scene.equipment.find((e) => e.id === anchorId)
  if (!anchor) return { ok: false, error: `設備が見つかりません: ${anchorId}` }
  const units = unitsOf(scene)
  const memberIds = units.get(anchor.id)
  if (!memberIds) return { ok: false, error: `${anchor.name}は基準の設備ではありません（設備の種類の役割が「基準」のものに付けます）` }
  const recipe = recipeFor(scene, anchor)
  if (!recipe) {
    const name = findTemplate(scene.templates, anchor.kind)?.name ?? anchor.kind
    return { ok: false, error: `${name}に付ける付帯設備の決まりがありません（今は射出成形の成形機だけ）` }
  }
  const members = memberIds.map((id) => scene.equipment.find((e) => e.id === id)!)
  const frame = frameFor(scene, anchor, members, recipe, o)
  if (typeof frame === 'string') return { ok: false, error: frame }
  const rotation = rotationFor(anchor)

  // 使う設備: ユニットに同じ種類があればそれを（工程の順に 1 台ずつ）、無ければ新しく置く
  const used = new Set<string>()
  // 同じ種類が多ければ、つなぎの順で先のものから使う（余った分は動かさない）。溜める設備（ストッカーと予備）もこの順で、
  // 先のものを主に使う（再生は先のつなぎから満杯まで入れるため、主と予備を入れ替えない）
  const take = (kind: string) => {
    const m = byLinkOrder(scene, anchor, members, kind).find((x) => !used.has(x.id))
    if (m) used.add(m.id)
    return m
  }
  const commands: Command[] = []
  let work = scene
  const missing: string[] = []
  const make = (kind: string, name?: string): Equipment | null => {
    const t = findTemplate(scene.templates, kind)
    if (!t) {
      missing.push(kind)
      return null
    }
    const e = equipmentFromTemplate(t, { id: nextEquipmentId(work), name: name ?? nextEquipmentName(work, t), center: { x: anchor.x, y: anchor.y }, rotation })
    work = { ...work, equipment: [...work.equipment, e] }
    return e
  }
  const robot = recipe.mounted ? (take(recipe.mounted.kind) ?? make(recipe.mounted.kind)) : null
  const chain = recipe.chain.map((k) => take(k) ?? make(k))
  const buffers: (Equipment | null)[] = []
  for (const [i, k] of recipe.buffers.entries()) {
    const first = buffers[0]
    buffers.push(take(k) ?? make(k, i > 0 && first ? `${first.name} 予備` : undefined))
  }
  if (missing.length)
    return { ok: false, error: `設備の種類が一覧にありません: ${[...new Set(missing)].join(', ')}（「設備の種類を編集」で射出成形の組を足してください）` }

  // 向きを揃えてから位置を決める（回すと外形の縦横が入れ替わる）
  const turned = (e: Equipment): Equipment => ({ ...e, rotation })
  const robotT = robot ? turned(robot) : null
  const robotAt = robotT ? robotPlace(frame, recipe, robotT) : null
  const placedRobot = robotT && robotAt ? { ...robotT, ...robotAt } : null
  const row = [...chain, ...buffers].map((e) => turned(e!))
  const at = layRow(frame, row, rowStart(frame, placedRobot))

  const isNew = (e: Equipment) => !scene.equipment.some((x) => x.id === e.id)
  const place = (e: Equipment, p: Point) => {
    if (isNew(e)) commands.push({ type: 'add', equipment: { ...e, rotation, x: p.x, y: p.y } })
    else {
      if (e.rotation !== rotation) commands.push({ type: 'rotate', ids: [e.id], quarterTurns: (rotation - e.rotation) / 90 })
      if (e.x !== p.x || e.y !== p.y) commands.push({ type: 'move', ids: [e.id], dx: p.x - e.x, dy: p.y - e.y })
    }
  }
  if (robot && robotAt) place(robot, robotAt)
  for (const e of row) place(e, at.get(e.id)!)

  // つなぎ: 基準 → 載る → 列の順、列の最後 → 溜める設備それぞれ。もうあるものは足さない
  // つなぎ: 基準 → 載る → 列の順、列の最後 → 溜める設備それぞれ。逆向き（取出機 → 成形機）につないであれば、そのまま使う。
  // 使う設備どうしの、決まりと違うつなぎ（順が入れ替わったものなど）は外してから足す（足すと輪になって断られるため）。
  // 使わない設備（余った分）やユニットの外とのつなぎは触らない
  const desired: { from: string; to: string }[] = []
  let prev = anchor.id
  if (robot) {
    if (scene.links.some((l) => l.from === robot.id && l.to === anchor.id)) desired.push({ from: robot.id, to: anchor.id })
    else desired.push({ from: anchor.id, to: robot.id })
    prev = robot.id
  }
  for (const e of chain) {
    desired.push({ from: prev, to: e!.id })
    prev = e!.id
  }
  for (const b of buffers) desired.push({ from: prev, to: b!.id })
  const same = (a: { from: string; to: string }, b: { from: string; to: string }) => a.from === b.from && a.to === b.to
  const usedIds = new Set([anchor.id, ...[robot, ...chain, ...buffers].map((e) => e!.id)])
  const stale = scene.links.filter((l) => usedIds.has(l.from) && usedIds.has(l.to) && !desired.some((d) => same(d, l)))
  const links = desired.filter((d) => !scene.links.some((l) => same(l, d)))
  if (stale.length) commands.push({ type: 'unlink', links: stale })
  if (links.length) commands.push({ type: 'link', links })

  const added = [robot, ...chain, ...buffers].filter((e): e is Equipment => !!e && isNew(e)).length
  const note = `${anchor.name}: 取り出し側 ${SIDE_NAME[frame.side]}、${SIDE_NAME[frame.toward]}へ並べる（${added ? `${added} 台を置き、` : ''}${[robot, ...chain, ...buffers].length - added} 台を動かす）`
  if (commands.length === 0) return { ok: true, command: null, note: `${anchor.name}: もう決まりどおりです` }
  return { ok: true, command: commands.length === 1 ? commands[0]! : { type: 'batch', commands }, note }
}

// 整える: ユニットの付帯設備（載る設備を除く）を、今の並びの順と向きのまま、余白ちょうどの間隔で列の線に揃える
export function arrangeUnit(scene: Scene, anchorId: string): AttachResult {
  const anchor = scene.equipment.find((e) => e.id === anchorId)
  if (!anchor) return { ok: false, error: `設備が見つかりません: ${anchorId}` }
  const memberIds = unitsOf(scene).get(anchor.id)
  if (!memberIds) return { ok: false, error: `${anchor.name}は基準の設備ではありません` }
  const recipe = recipeFor(scene, anchor)
  if (!recipe) {
    const name = findTemplate(scene.templates, anchor.kind)?.name ?? anchor.kind
    return { ok: false, error: `${name}を整える付帯設備の決まりがありません（今は射出成形の成形機だけ）` }
  }
  const members = memberIds.map((id) => scene.equipment.find((e) => e.id === id)!)
  const robot = mountedOf(scene, anchor, members, recipe) ?? null
  // 載る設備（役割が mounted）は基準の上にあるので、列には入れない
  const mounted = new Set(members.filter((m) => findTemplate(scene.templates, m.kind)?.role === 'mounted').map((m) => m.id))
  const row = members.filter((m) => !mounted.has(m.id))
  if (row.length === 0) return { ok: true, command: null, note: `${anchor.name}: 整える付帯設備がありません` }
  const frame = frameFor(scene, anchor, members, recipe, {})
  if (typeof frame === 'string') return { ok: false, error: frame }
  // 並びの順: 並べる向きの座標の小さい順（今の順を保つ）
  const t = VEC[frame.toward]
  const sorted = [...row].sort((a, b) => dot(a, t) - dot(b, t))
  const at = layRow(frame, sorted, rowStart(frame, robot))
  const moves: Command[] = []
  for (const m of sorted) {
    const p = at.get(m.id)!
    if (m.x !== p.x || m.y !== p.y) moves.push({ type: 'move', ids: [m.id], dx: p.x - m.x, dy: p.y - m.y })
  }
  if (moves.length === 0) return { ok: true, command: null, note: `${anchor.name}: もう揃っています` }
  return {
    ok: true,
    command: moves.length === 1 ? moves[0]! : { type: 'batch', commands: moves },
    note: `${anchor.name}: ${moves.length} 台を揃える（取り出し側 ${SIDE_NAME[frame.side]}、${SIDE_NAME[frame.toward]}へ）`,
  }
}

// 何台かにまとめて当てる（画面のボタンで複数を選んだとき、AI の指示）。1 台ずつ前の結果に当てていく
export function forAnchors(
  scene: Scene,
  anchorIds: readonly string[],
  f: (s: Scene, id: string) => AttachResult,
  apply: (s: Scene, c: Command) => Scene | string,
): { ok: true; command: Command | null; notes: string[] } | { ok: false; error: string } {
  let work = scene
  const commands: Command[] = []
  const notes: string[] = []
  for (const id of anchorIds) {
    const r = f(work, id)
    if (!r.ok) return r
    notes.push(r.note)
    if (!r.command) continue
    const next = apply(work, r.command)
    if (typeof next === 'string') return { ok: false, error: next }
    work = next
    commands.push(r.command)
  }
  if (commands.length === 0) return { ok: true, command: null, notes }
  return { ok: true, command: commands.length === 1 ? commands[0]! : { type: 'batch', commands }, notes }
}
