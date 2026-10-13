// シーンを変える操作（コマンド）。画面・保存・元に戻す・AI の操作は、すべてここを通る。
// applyCommand は純関数で、元のシーンを書き換えず、新しいシーンを返す。

import { checkAisle, type Aisle } from './aisle'
import { calibrate, checkBackground, type Background } from './background'
import { checkSite, type Site } from './site'
import { SCENE_VERSION, createEmptyScene, duplicateName, footprint, type Equipment, type Rotation, type Scene } from './scene'
import type { Point } from './viewport'

export type Command =
  | { type: 'add'; equipment: Equipment } // 設備を置く。id は呼ぶ側が決める（nextEquipmentId）
  | { type: 'move'; ids: string[]; dx: number; dy: number } // 設備をずらす（mm）
  | { type: 'rotate'; ids: string[]; quarterTurns: number } // 各設備の中心のまわりに 90 度 × n 回す。正が時計回り
  | { type: 'remove'; ids: string[] } // 設備を消す
  | { type: 'duplicate'; ids: string[]; newIds: string[]; dx: number; dy: number } // 設備を写して dx, dy ずらして置く。新しい id は呼ぶ側が決め、ids と同じ順に並べる
  | { type: 'update'; ids: string[]; changes: EquipmentChanges } // 置いた設備の名前・寸法・色を変える。寸法を変えても外接の長方形の左上と回転は動かさない
  | { type: 'setBackground'; background: Background | null } // 背景の画像を置く・差し替える・外す（null）
  | { type: 'calibrateBackground'; a: Point; b: Point; distance: number } // 図面の上の 2 点が distance mm 離れているとして縮尺を合わせる。a は動かない
  | { type: 'moveBackground'; dx: number; dy: number } // 背景をずらす（mm）
  | { type: 'setSite'; site: Site | null } // 敷地の外形を描く・差し替える・消す（null）
  | { type: 'addAisle'; aisle: Aisle } // AGV の通路を描く。id は呼ぶ側が決める（nextAisleId）
  | { type: 'updateAisle'; ids: string[]; changes: AisleChanges } // 通路の名前・幅を変える。中心線は動かさない
  | { type: 'removeAisle'; ids: string[] } // 通路を消す
  | { type: 'loadScene'; scene: Scene } // シーンをまるごと差し替える（ファイルを開く・新規）。中身は 1 つずつ確かめ直す

// update で変えられる項目。書いたものだけ変える
export type EquipmentChanges = { name?: string; width?: number; depth?: number; color?: string }

// updateAisle で変えられる項目。書いたものだけ変える
export type AisleChanges = { name?: string; width?: number }

export type CommandResult = { ok: true; scene: Scene } | { ok: false; error: string }

export function applyCommand(scene: Scene, cmd: Command): CommandResult {
  switch (cmd.type) {
    case 'add':
      return add(scene, cmd.equipment)
    case 'move':
      return move(scene, cmd.ids, cmd.dx, cmd.dy)
    case 'rotate':
      return rotate(scene, cmd.ids, cmd.quarterTurns)
    case 'remove':
      return remove(scene, cmd.ids)
    case 'duplicate':
      return duplicate(scene, cmd.ids, cmd.newIds, cmd.dx, cmd.dy)
    case 'update':
      return update(scene, cmd.ids, cmd.changes)
    case 'setBackground':
      return setBackground(scene, cmd.background)
    case 'calibrateBackground':
      return calibrateBackground(scene, cmd.a, cmd.b, cmd.distance)
    case 'moveBackground':
      return moveBackground(scene, cmd.dx, cmd.dy)
    case 'setSite':
      return setSite(scene, cmd.site)
    case 'addAisle':
      return addAisle(scene, cmd.aisle)
    case 'updateAisle':
      return updateAisle(scene, cmd.ids, cmd.changes)
    case 'removeAisle':
      return removeAisle(scene, cmd.ids)
    case 'loadScene':
      return loadScene(cmd.scene)
  }
}

const ROTATIONS: readonly Rotation[] = [0, 90, 180, 270]

function fail(error: string): CommandResult {
  return { ok: false, error }
}

function add(scene: Scene, eq: Equipment): CommandResult {
  if (typeof eq.id !== 'string' || !eq.id) return fail('設備の id が空です')
  for (const k of ['kind', 'name', 'color'] as const)
    if (typeof eq[k] !== 'string') return fail(`設備 ${eq.id} の ${k} が文字列ではありません`)
  if (scene.equipment.some((e) => e.id === eq.id)) return fail(`設備の id が重複しています: ${eq.id}`)
  if (!Number.isFinite(eq.x) || !Number.isFinite(eq.y)) return fail('設備の位置が数ではありません')
  if (!(eq.width > 0 && eq.depth > 0 && Number.isFinite(eq.width) && Number.isFinite(eq.depth)))
    return fail('設備の幅と奥行は正の数にしてください')
  if (!ROTATIONS.includes(eq.rotation)) return fail('回転は 0・90・180・270 のどれかです')
  const { id, kind, name, x, y, width, depth, rotation, color } = eq
  return { ok: true, scene: { ...scene, equipment: [...scene.equipment, { id, kind, name, x, y, width, depth, rotation, color }] } }
}

// ids がすべて存在し、重複がないことを確かめる
function checkIds(scene: Scene, ids: string[]): string | null {
  if (ids.length === 0) return '対象の設備がありません'
  if (new Set(ids).size !== ids.length) return '対象の設備が重複しています'
  const missing = ids.filter((id) => !scene.equipment.some((e) => e.id === id))
  if (missing.length > 0) return `設備が見つかりません: ${missing.join(', ')}`
  return null
}

function updateEach(scene: Scene, ids: string[], f: (eq: Equipment) => Equipment): Scene {
  const targets = new Set(ids)
  return { ...scene, equipment: scene.equipment.map((e) => (targets.has(e.id) ? f(e) : e)) }
}

function move(scene: Scene, ids: string[], dx: number, dy: number): CommandResult {
  const bad = checkIds(scene, ids)
  if (bad) return fail(bad)
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return fail('移動量が数ではありません')
  return { ok: true, scene: updateEach(scene, ids, (e) => ({ ...e, x: e.x + dx, y: e.y + dy })) }
}

function rotate(scene: Scene, ids: string[], quarterTurns: number): CommandResult {
  const bad = checkIds(scene, ids)
  if (bad) return fail(bad)
  if (!Number.isInteger(quarterTurns)) return fail('回す量は 90 度の整数倍です')
  const turn = (r: Rotation): Rotation => ROTATIONS[(((r / 90 + quarterTurns) % 4) + 4) % 4]!
  return { ok: true, scene: updateEach(scene, ids, (e) => ({ ...e, rotation: turn(e.rotation) })) }
}

function remove(scene: Scene, ids: string[]): CommandResult {
  const bad = checkIds(scene, ids)
  if (bad) return fail(bad)
  const targets = new Set(ids)
  return { ok: true, scene: { ...scene, equipment: scene.equipment.filter((e) => !targets.has(e.id)) } }
}

// 写しは元の設備の並び順のまま末尾に足す。名前は番号の続きにする（duplicateName）
function duplicate(scene: Scene, ids: string[], newIds: string[], dx: number, dy: number): CommandResult {
  const bad = checkIds(scene, ids)
  if (bad) return fail(bad)
  if (!Array.isArray(newIds) || newIds.length !== ids.length) return fail('新しい id の数が対象の設備の数と違います')
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return fail('ずらす量が数ではありません')
  let r: CommandResult = { ok: true, scene }
  for (const [i, id] of ids.entries()) {
    const src = scene.equipment.find((e) => e.id === id)!
    r = add(r.scene, { ...src, id: newIds[i]!, name: duplicateName(r.scene, src.name), x: src.x + dx, y: src.y + dy })
    if (!r.ok) return r
  }
  return r
}

const COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

function update(scene: Scene, ids: string[], changes: EquipmentChanges): CommandResult {
  const bad = checkIds(scene, ids)
  if (bad) return fail(bad)
  if (typeof changes !== 'object' || changes === null) return fail('変える項目がありません')
  const { name, width, depth, color } = changes
  if (name === undefined && width === undefined && depth === undefined && color === undefined) return fail('変える項目がありません')
  if (name !== undefined && (typeof name !== 'string' || !name.trim())) return fail('名前を入れてください')
  for (const v of [width, depth])
    if (v !== undefined && !(typeof v === 'number' && v > 0 && Number.isFinite(v))) return fail('設備の幅と奥行は正の数にしてください')
  if (color !== undefined && (typeof color !== 'string' || !COLOR.test(color))) return fail('色は #rrggbb の形で書いてください')
  const set: EquipmentChanges = {}
  if (name !== undefined) set.name = name.trim()
  if (width !== undefined) set.width = width
  if (depth !== undefined) set.depth = depth
  if (color !== undefined) set.color = color.toLowerCase()
  // 寸法を変えたら、外接の長方形の左上がそのままになるよう中心をずらす（スナップした位置や左・上の隣との接し方を崩さない）
  return {
    ok: true,
    scene: updateEach(scene, ids, (e) => {
      const next = { ...e, ...set }
      const a = footprint(e)
      const b = footprint(next)
      return { ...next, x: e.x + (a.x - b.x), y: e.y + (a.y - b.y) }
    }),
  }
}

function setBackground(scene: Scene, bg: Background | null): CommandResult {
  if (bg === null) return { ok: true, scene: { ...scene, background: null } }
  const bad = checkBackground(bg)
  if (bad) return fail(bad)
  const { src, name, pixelWidth, pixelHeight, x, y, mmPerPixel } = bg
  const background = { src, name: typeof name === 'string' ? name : '', pixelWidth, pixelHeight, x, y, mmPerPixel, calibrated: bg.calibrated === true }
  return { ok: true, scene: { ...scene, background } }
}

function calibrateBackground(scene: Scene, a: Point, b: Point, distance: number): CommandResult {
  if (!scene.background) return fail('背景の画像がありません')
  const r = calibrate(scene.background, a, b, distance)
  if (!r.ok) return fail(r.error)
  return { ok: true, scene: { ...scene, background: r.background } }
}

function moveBackground(scene: Scene, dx: number, dy: number): CommandResult {
  const bg = scene.background
  if (!bg) return fail('背景の画像がありません')
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return fail('移動量が数ではありません')
  return { ok: true, scene: { ...scene, background: { ...bg, x: bg.x + dx, y: bg.y + dy } } }
}

function setSite(scene: Scene, site: Site | null): CommandResult {
  if (site === null) return { ok: true, scene: { ...scene, site: null } }
  const bad = checkSite(site)
  if (bad) return fail(bad)
  return { ok: true, scene: { ...scene, site: { points: site.points.map(({ x, y }) => ({ x, y })) } } }
}

function addAisle(scene: Scene, a: Aisle): CommandResult {
  const bad = checkAisle(a)
  if (bad) return fail(bad)
  if (scene.aisles.some((x) => x.id === a.id)) return fail(`通路の id が重複しています: ${a.id}`)
  const aisle: Aisle = { id: a.id, name: a.name.trim(), points: a.points.map(({ x, y }) => ({ x, y })), width: a.width, closed: a.closed }
  return { ok: true, scene: { ...scene, aisles: [...scene.aisles, aisle] } }
}

function checkAisleIds(scene: Scene, ids: string[]): string | null {
  if (!Array.isArray(ids) || ids.length === 0) return '対象の通路がありません'
  if (new Set(ids).size !== ids.length) return '対象の通路が重複しています'
  const missing = ids.filter((id) => !scene.aisles.some((a) => a.id === id))
  if (missing.length > 0) return `通路が見つかりません: ${missing.join(', ')}`
  return null
}

function updateAisle(scene: Scene, ids: string[], changes: AisleChanges): CommandResult {
  const bad = checkAisleIds(scene, ids)
  if (bad) return fail(bad)
  if (typeof changes !== 'object' || changes === null) return fail('変える項目がありません')
  const { name, width } = changes
  if (name === undefined && width === undefined) return fail('変える項目がありません')
  if (name !== undefined && (typeof name !== 'string' || !name.trim())) return fail('名前を入れてください')
  if (width !== undefined && !(typeof width === 'number' && width > 0 && Number.isFinite(width))) return fail('通路の幅は正の数にしてください')
  const set: AisleChanges = {}
  if (name !== undefined) set.name = name.trim()
  if (width !== undefined) set.width = width
  const targets = new Set(ids)
  return { ok: true, scene: { ...scene, aisles: scene.aisles.map((a) => (targets.has(a.id) ? { ...a, ...set } : a)) } }
}

function removeAisle(scene: Scene, ids: string[]): CommandResult {
  const bad = checkAisleIds(scene, ids)
  if (bad) return fail(bad)
  const targets = new Set(ids)
  return { ok: true, scene: { ...scene, aisles: scene.aisles.filter((a) => !targets.has(a.id)) } }
}

// 空のシーンに背景・敷地・設備・通路を 1 つずつ足し直して作る。外から来たシーン（ファイル・AI）も、置くときと同じ確かめを通る。
// 知らない項目は落とす
function loadScene(next: Scene): CommandResult {
  if (typeof next !== 'object' || next === null) return fail('シーンの形ではありません')
  if (next.version !== SCENE_VERSION) return fail(`シーンの版が違います（${String(next.version)}。読めるのは ${SCENE_VERSION}）`)
  if (!Array.isArray(next.equipment)) return fail('設備の一覧（equipment）がありません')
  let r: CommandResult = { ok: true, scene: createEmptyScene() }
  if (next.background !== null && next.background !== undefined) {
    if (typeof next.background !== 'object') return fail('背景（background）の形ではありません')
    r = setBackground(r.scene, next.background)
    if (!r.ok) return r
  }
  if (next.site !== null && next.site !== undefined) {
    r = setSite(r.scene, next.site)
    if (!r.ok) return r
  }
  for (const [i, eq] of next.equipment.entries()) {
    if (typeof eq !== 'object' || eq === null) return fail(`${i + 1} 番目の設備が設備の形ではありません`)
    r = add(r.scene, eq)
    if (!r.ok) return r
  }
  if (!Array.isArray(next.aisles)) return fail('通路の一覧（aisles）がありません')
  for (const [i, a] of next.aisles.entries()) {
    if (typeof a !== 'object' || a === null) return fail(`${i + 1} 番目の通路が通路の形ではありません`)
    r = addAisle(r.scene, a)
    if (!r.ok) return r
  }
  return r
}
