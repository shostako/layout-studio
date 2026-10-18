// シーンを変える操作（コマンド）。画面・保存・元に戻す・AI の操作は、すべてここを通る。
// applyCommand は純関数で、元のシーンを書き換えず、新しいシーンを返す。

import { checkAisle, type Aisle } from './aisle'
import { calibrate, checkBackground, type Background } from './background'
import { checkLink, sameLink, type Link } from './flow'
import { checkSite, type Site } from './site'
import { DEFAULT_FLOW_SETTINGS, FLOW_LIMITS, NO_CLEARANCE, SCENE_VERSION, createEmptyScene, duplicateName, footprint, type Clearance, type Equipment, type FlowSettings, type Rotation, type Scene } from './scene'
import { INJECTION_PRESET, checkTemplates, normalizeTemplates, type EquipmentTemplate } from './templates'
import type { Point } from './viewport'
import { checkZone, type Zone } from './zone'

export type Command =
  | { type: 'add'; equipment: Equipment } // 設備を置く。id は呼ぶ側が決める（nextEquipmentId）
  | { type: 'move'; ids: string[]; dx: number; dy: number } // 設備をずらす（mm）
  | { type: 'rotate'; ids: string[]; quarterTurns: number } // 各設備の中心のまわりに 90 度 × n 回す。正が時計回り
  | { type: 'rotateAbout'; ids: string[]; quarterTurns: number; pivot: Point } // 設備をまとめて pivot のまわりに 90 度 × n 回す（中心の位置も向きも回る。ユニットごと回すのに使う）。正が時計回り
  | { type: 'remove'; ids: string[] } // 設備を消す。その設備につないだつなぎも消す
  | { type: 'duplicate'; ids: string[]; newIds: string[]; dx: number; dy: number } // 設備を写して dx, dy ずらして置く。新しい id は呼ぶ側が決め、ids と同じ順に並べる。写した設備どうしのつなぎも写す
  | { type: 'update'; ids: string[]; changes: EquipmentChanges } // 置いた設備の名前・寸法・色・余白を変える。寸法を変えても外接の長方形の左上と回転は動かさない
  | { type: 'setBackground'; background: Background | null } // 背景の画像を置く・差し替える・外す（null）
  | { type: 'calibrateBackground'; a: Point; b: Point; distance: number } // 図面の上の 2 点が distance mm 離れているとして縮尺を合わせる。a は動かない
  | { type: 'moveBackground'; dx: number; dy: number } // 背景をずらす（mm）
  | { type: 'setSite'; site: Site | null } // 敷地の外形を描く・差し替える・消す（null）
  | { type: 'addAisle'; aisle: Aisle } // AGV の通路を描く。id は呼ぶ側が決める（nextAisleId）
  | { type: 'updateAisle'; ids: string[]; changes: AisleChanges } // 通路の名前・幅・一方通行を変える。中心線は動かさない（向きを逆にするのは setAislePoints で頂点を逆順に）
  | { type: 'removeAisle'; ids: string[] } // 通路を消す
  | { type: 'moveAisle'; ids: string[]; dx: number; dy: number } // 通路を中心線ごとずらす（mm）
  | { type: 'setAislePoints'; id: string; points: Point[] } // 通路の中心線の頂点を差し替える（頂点を動かす・足す・消す）。周回かどうかは変えない
  | { type: 'addZone'; zone: Zone } // 置けない所を足す。id は呼ぶ側が決める（nextZoneId）
  | { type: 'updateZone'; ids: string[]; changes: ZoneChanges } // 置けない所の名前・位置・大きさを変える
  | { type: 'removeZone'; ids: string[] } // 置けない所を消す
  | { type: 'moveZone'; ids: string[]; dx: number; dy: number } // 置けない所をずらす（mm）
  | { type: 'link'; links: Link[] } // 工程のつなぎを足す（from → to）。1 本でも断られたら、どれも足さない
  | { type: 'unlink'; links: Link[] } // 工程のつなぎを外す
  | { type: 'setFlow'; changes: Partial<FlowSettings> } // 流れの再生の数値（サイクル・ストッカーの容量・AGV の速さ・入れ替えの時間）を変える。書いたものだけ変える
  | { type: 'setTemplates'; templates: EquipmentTemplate[] } // 設備の種類（ひな形）の一覧を差し替える（足す・変える・消す・並べ替える）。置いてある設備の種類は消せない。置いた設備は変えない
  | { type: 'loadScene'; scene: Scene } // シーンをまるごと差し替える（ファイルを開く・新規）。中身は 1 つずつ確かめ直す
  | { type: 'batch'; commands: Command[] } // コマンドを順に当て、まとめて 1 つの操作にする（AI の 1 回の応答など）。1 つでも断られたら、どれも当てない

// update で変えられる項目。書いたものだけ変える
// clearance は書いた辺だけ変える
export type EquipmentChanges = { name?: string; width?: number; depth?: number; color?: string; clearance?: Partial<Clearance> }

// updateZone で変えられる項目。書いたものだけ変える
export type ZoneChanges = { name?: string; x?: number; y?: number; width?: number; height?: number }

// updateAisle で変えられる項目。書いたものだけ変える
export type AisleChanges = { name?: string; width?: number; oneWay?: boolean }

export type CommandResult = { ok: true; scene: Scene } | { ok: false; error: string }

export function applyCommand(scene: Scene, cmd: Command): CommandResult {
  switch (cmd.type) {
    case 'add':
      return add(scene, cmd.equipment)
    case 'move':
      return move(scene, cmd.ids, cmd.dx, cmd.dy)
    case 'rotate':
      return rotate(scene, cmd.ids, cmd.quarterTurns)
    case 'rotateAbout':
      return rotateAbout(scene, cmd.ids, cmd.quarterTurns, cmd.pivot)
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
    case 'moveAisle':
      return moveAisle(scene, cmd.ids, cmd.dx, cmd.dy)
    case 'setAislePoints':
      return setAislePoints(scene, cmd.id, cmd.points)
    case 'addZone':
      return addZone(scene, cmd.zone)
    case 'updateZone':
      return updateZone(scene, cmd.ids, cmd.changes)
    case 'removeZone':
      return removeZone(scene, cmd.ids)
    case 'moveZone':
      return moveZone(scene, cmd.ids, cmd.dx, cmd.dy)
    case 'link':
      return link(scene, cmd.links)
    case 'unlink':
      return unlink(scene, cmd.links)
    case 'setFlow':
      return setFlow(scene, cmd.changes)
    case 'setTemplates':
      return setTemplates(scene, cmd.templates)
    case 'loadScene':
      return loadScene(cmd.scene)
    case 'batch':
      return batch(scene, cmd.commands)
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
  // 余白を書かなければ 0（AI が余白を書かずに置けるように）
  const c = eq.clearance === undefined ? NO_CLEARANCE : eq.clearance
  const badC = checkClearance(c, true)
  if (badC) return fail(`設備 ${eq.id} の${badC}`)
  const { id, kind, name, x, y, width, depth, rotation, color } = eq
  const clearance = { top: c.top, right: c.right, bottom: c.bottom, left: c.left }
  return { ok: true, scene: { ...scene, equipment: [...scene.equipment, { id, kind, name, x, y, width, depth, rotation, color, clearance }] } }
}

const SIDES = ['top', 'right', 'bottom', 'left'] as const

// 余白の各辺が 0 以上の数か。all なら 4 辺すべてを求める（update では書いた辺だけ）
function checkClearance(c: unknown, all: boolean): string | null {
  if (typeof c !== 'object' || c === null) return '余白（clearance）の形ではありません'
  const r = c as Record<string, unknown>
  for (const k of SIDES) {
    const v = r[k]
    if (v === undefined && !all) continue
    if (!(typeof v === 'number' && v >= 0 && Number.isFinite(v))) return '余白は上・右・下・左とも 0 以上の数にしてください'
  }
  return null
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
  const equipment = scene.equipment.filter((e) => !targets.has(e.id))
  const links = scene.links.filter((l) => !targets.has(l.from) && !targets.has(l.to))
  return { ok: true, scene: { ...scene, equipment, links } }
}

// 写しは元の設備の並び順のまま末尾に足す。名前は番号の続きにする（duplicateName）
function rotateAbout(scene: Scene, ids: string[], quarterTurns: number, pivot: Point): CommandResult {
  const bad = checkIds(scene, ids)
  if (bad) return fail(bad)
  if (!Number.isInteger(quarterTurns)) return fail('回す量は 90 度の整数倍です')
  if (typeof pivot !== 'object' || pivot === null || !Number.isFinite(pivot.x) || !Number.isFinite(pivot.y)) return fail('回す中心（pivot）が点ではありません')
  const q = ((quarterTurns % 4) + 4) % 4
  // 画面は y が下向きなので、時計回りの 90 度は (dx, dy) → (-dy, dx)
  const spin = (dx: number, dy: number): [number, number] => {
    let [x, y] = [dx, dy]
    for (let i = 0; i < q; i++) [x, y] = [-y, x]
    return [x, y]
  }
  const turn = (r: Rotation): Rotation => ROTATIONS[(r / 90 + q) % 4]!
  return {
    ok: true,
    scene: updateEach(scene, ids, (e) => {
      const [dx, dy] = spin(e.x - pivot.x, e.y - pivot.y)
      return { ...e, x: pivot.x + dx, y: pivot.y + dy, rotation: turn(e.rotation) }
    }),
  }
}

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
  // 写した設備どうしのつなぎを、写しどうしにも張る（1 列を写すと、写しも同じ順につながる）
  const copyOf = new Map(ids.map((id, i) => [id, newIds[i]!]))
  const copied = scene.links.flatMap((l) => {
    const from = copyOf.get(l.from)
    const to = copyOf.get(l.to)
    return from !== undefined && to !== undefined ? [{ from, to }] : []
  })
  return copied.length ? link(r.scene, copied) : r
}

const COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

function update(scene: Scene, ids: string[], changes: EquipmentChanges): CommandResult {
  const bad = checkIds(scene, ids)
  if (bad) return fail(bad)
  if (typeof changes !== 'object' || changes === null) return fail('変える項目がありません')
  const { name, width, depth, color, clearance } = changes
  if (name === undefined && width === undefined && depth === undefined && color === undefined && clearance === undefined)
    return fail('変える項目がありません')
  if (name !== undefined && (typeof name !== 'string' || !name.trim())) return fail('名前を入れてください')
  for (const v of [width, depth])
    if (v !== undefined && !(typeof v === 'number' && v > 0 && Number.isFinite(v))) return fail('設備の幅と奥行は正の数にしてください')
  if (color !== undefined && (typeof color !== 'string' || !COLOR.test(color))) return fail('色は #rrggbb の形で書いてください')
  if (clearance !== undefined) {
    const badC = checkClearance(clearance, false)
    if (badC) return fail(badC)
    if (!SIDES.some((k) => clearance[k] !== undefined)) return fail('変える余白の辺がありません')
  }
  const set: Omit<EquipmentChanges, 'clearance'> = {}
  if (name !== undefined) set.name = name.trim()
  if (width !== undefined) set.width = width
  if (depth !== undefined) set.depth = depth
  if (color !== undefined) set.color = color.toLowerCase()
  // 寸法を変えたら、外接の長方形の左上がそのままになるよう中心をずらす（スナップした位置や左・上の隣との接し方を崩さない）
  return {
    ok: true,
    scene: updateEach(scene, ids, (e) => {
      const next = { ...e, ...set }
      if (clearance !== undefined) {
        const c = { ...e.clearance }
        for (const k of SIDES) if (clearance[k] !== undefined) c[k] = clearance[k]
        next.clearance = c
      }
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
  const aisle: Aisle = { id: a.id, name: a.name.trim(), points: a.points.map(({ x, y }) => ({ x, y })), width: a.width, closed: a.closed, ...(a.oneWay ? { oneWay: true } : {}) }
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
  const { name, width, oneWay } = changes
  if (name === undefined && width === undefined && oneWay === undefined) return fail('変える項目がありません')
  if (oneWay !== undefined && typeof oneWay !== 'boolean') return fail('一方通行は true か false にしてください')
  if (name !== undefined && (typeof name !== 'string' || !name.trim())) return fail('名前を入れてください')
  if (width !== undefined && !(typeof width === 'number' && width > 0 && Number.isFinite(width))) return fail('通路の幅は正の数にしてください')
  const set: AisleChanges = {}
  if (name !== undefined) set.name = name.trim()
  if (width !== undefined) set.width = width
  const targets = new Set(ids)
  const change = (a: Aisle): Aisle => {
    const b = { ...a, ...set }
    // 両方向は項目を持たない（版 6 までのファイルと同じ形）
    if (oneWay === true) b.oneWay = true
    else if (oneWay === false) delete b.oneWay
    return b
  }
  return { ok: true, scene: { ...scene, aisles: scene.aisles.map((a) => (targets.has(a.id) ? change(a) : a)) } }
}

function removeAisle(scene: Scene, ids: string[]): CommandResult {
  const bad = checkAisleIds(scene, ids)
  if (bad) return fail(bad)
  const targets = new Set(ids)
  return { ok: true, scene: { ...scene, aisles: scene.aisles.filter((a) => !targets.has(a.id)) } }
}

function moveAisle(scene: Scene, ids: string[], dx: number, dy: number): CommandResult {
  const bad = checkAisleIds(scene, ids)
  if (bad) return fail(bad)
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return fail('移動量が数ではありません')
  const targets = new Set(ids)
  const shift = (a: Aisle): Aisle => ({ ...a, points: a.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) })
  return { ok: true, scene: { ...scene, aisles: scene.aisles.map((a) => (targets.has(a.id) ? shift(a) : a)) } }
}

// 頂点の列を差し替え、通路として受け付けられるかを確かめ直す（頂点が足りない・同じ点が続くなら断る）
function setAislePoints(scene: Scene, id: string, points: Point[]): CommandResult {
  const bad = checkAisleIds(scene, [id])
  if (bad) return fail(bad)
  if (!Array.isArray(points)) return fail('通路の頂点（points）がありません')
  const old = scene.aisles.find((a) => a.id === id)!
  const next: Aisle = { ...old, points: points.map((p) => ({ x: p?.x, y: p?.y })) }
  const badA = checkAisle(next)
  if (badA) return fail(badA)
  return { ok: true, scene: { ...scene, aisles: scene.aisles.map((a) => (a.id === id ? next : a)) } }
}

function addZone(scene: Scene, z: Zone): CommandResult {
  const bad = checkZone(z)
  if (bad) return fail(bad)
  if (scene.zones.some((x) => x.id === z.id)) return fail(`置けない所の id が重複しています: ${z.id}`)
  const zone: Zone = { id: z.id, name: z.name.trim(), x: z.x, y: z.y, width: z.width, height: z.height }
  return { ok: true, scene: { ...scene, zones: [...scene.zones, zone] } }
}

function checkZoneIds(scene: Scene, ids: string[]): string | null {
  if (!Array.isArray(ids) || ids.length === 0) return '対象の置けない所がありません'
  if (new Set(ids).size !== ids.length) return '対象の置けない所が重複しています'
  const missing = ids.filter((id) => !scene.zones.some((z) => z.id === id))
  if (missing.length > 0) return `置けない所が見つかりません: ${missing.join(', ')}`
  return null
}

function updateZone(scene: Scene, ids: string[], changes: ZoneChanges): CommandResult {
  const bad = checkZoneIds(scene, ids)
  if (bad) return fail(bad)
  if (typeof changes !== 'object' || changes === null) return fail('変える項目がありません')
  const keys = (['name', 'x', 'y', 'width', 'height'] as const).filter((k) => changes[k] !== undefined)
  if (keys.length === 0) return fail('変える項目がありません')
  const set: ZoneChanges = {}
  for (const k of keys) (set as Record<string, unknown>)[k] = k === 'name' && typeof changes.name === 'string' ? changes.name.trim() : changes[k]
  const targets = new Set(ids)
  const next = scene.zones.map((z) => (targets.has(z.id) ? { ...z, ...set } : z))
  for (const z of next) {
    if (!targets.has(z.id)) continue
    const badZ = checkZone(z)
    if (badZ) return fail(badZ)
  }
  return { ok: true, scene: { ...scene, zones: next } }
}

function removeZone(scene: Scene, ids: string[]): CommandResult {
  const bad = checkZoneIds(scene, ids)
  if (bad) return fail(bad)
  const targets = new Set(ids)
  return { ok: true, scene: { ...scene, zones: scene.zones.filter((z) => !targets.has(z.id)) } }
}

function moveZone(scene: Scene, ids: string[], dx: number, dy: number): CommandResult {
  const bad = checkZoneIds(scene, ids)
  if (bad) return fail(bad)
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return fail('移動量が数ではありません')
  const targets = new Set(ids)
  return { ok: true, scene: { ...scene, zones: scene.zones.map((z) => (targets.has(z.id) ? { ...z, x: z.x + dx, y: z.y + dy } : z)) } }
}

function link(scene: Scene, links: Link[]): CommandResult {
  if (!Array.isArray(links) || links.length === 0) return fail('つなぎがありません')
  let next = scene
  for (const l of links) {
    const bad = checkLink(next, l)
    if (bad) return fail(bad)
    next = { ...next, links: [...next.links, { from: l.from, to: l.to }] }
  }
  return { ok: true, scene: next }
}

function unlink(scene: Scene, links: Link[]): CommandResult {
  if (!Array.isArray(links) || links.length === 0) return fail('外すつなぎがありません')
  for (const l of links) {
    if (typeof l !== 'object' || l === null || !scene.links.some((x) => sameLink(x, l))) return fail('外すつなぎが見つかりません')
  }
  return { ok: true, scene: { ...scene, links: scene.links.filter((x) => !links.some((l) => sameLink(x, l))) } }
}

const FLOW_KEYS = Object.keys(FLOW_LIMITS) as (keyof FlowSettings)[]

// 流れの再生の数値が範囲に入っているか。all ならすべてを求める（setFlow では書いたものだけ）
function checkFlow(f: unknown, all: boolean): string | null {
  if (typeof f !== 'object' || f === null) return '流れの再生の数値（flow）の形ではありません'
  const r = f as Record<string, unknown>
  for (const k of FLOW_KEYS) {
    const v = r[k]
    if (v === undefined && !all) continue
    const { min, max, integer, label } = FLOW_LIMITS[k]
    if (!(typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max && (!integer || Number.isInteger(v))))
      return `${label}は ${min} 以上 ${max} 以下の${integer ? '整数' : '数'}にしてください`
  }
  return null
}

function setTemplates(scene: Scene, templates: EquipmentTemplate[]): CommandResult {
  const bad = checkTemplates(templates)
  if (bad) return fail(bad)
  const kinds = new Set(templates.map((t) => t.kind))
  // 一覧にあった種類で、置いてある設備が使っているものは消せない（一覧に無い種類の設備は、前から無いのでそのまま）
  const gone = scene.templates.filter((t) => !kinds.has(t.kind) && scene.equipment.some((e) => e.kind === t.kind))
  if (gone.length) return fail(`置いてある設備の種類は消せません: ${gone.map((t) => t.name).join('、')}（先に設備を消してください）`)
  return { ok: true, scene: { ...scene, templates: normalizeTemplates(templates) } }
}

function setFlow(scene: Scene, changes: Partial<FlowSettings>): CommandResult {
  const bad = checkFlow(changes, false)
  if (bad) return fail(bad)
  const c = changes as Record<string, unknown>
  if (!FLOW_KEYS.some((k) => c[k] !== undefined)) return fail('変える数値がありません')
  const flow = { ...scene.flow }
  for (const k of FLOW_KEYS) if (c[k] !== undefined) flow[k] = c[k] as number
  return { ok: true, scene: { ...scene, flow } }
}

// 前のコマンドの結果に次のコマンドを当てていく。断られたら何番目の何かを理由に添える
function batch(scene: Scene, commands: Command[]): CommandResult {
  if (!Array.isArray(commands) || commands.length === 0) return fail('まとめるコマンドがありません')
  let next = scene
  for (const [i, c] of commands.entries()) {
    if (typeof c !== 'object' || c === null) return fail(`${i + 1} 番目がコマンドの形ではありません`)
    const r = applyCommand(next, c)
    if (!r.ok) return fail(`${i + 1} 番目（${String(c.type)}）: ${r.error}`)
    next = r.scene
  }
  return { ok: true, scene: next }
}

// 空のシーンに背景・敷地・設備・通路・つなぎを 1 つずつ足し直して作る。外から来たシーン（ファイル・AI）も、置くときと同じ確かめを通る。
// 知らない項目は落とす
function loadScene(next: Scene): CommandResult {
  if (typeof next !== 'object' || next === null) return fail('シーンの形ではありません')
  if (next.version !== SCENE_VERSION) return fail(`シーンの版が違います（${String(next.version)}。読めるのは ${SCENE_VERSION}）`)
  if (!Array.isArray(next.equipment)) return fail('設備の一覧（equipment）がありません')
  // 種類の一覧を書かなければ射出成形の組（AI が一覧を書かずにシーンを作れるように）
  const templates = next.templates === undefined ? INJECTION_PRESET : next.templates
  const badT = checkTemplates(templates)
  if (badT) return fail(badT)
  let r: CommandResult = { ok: true, scene: createEmptyScene(normalizeTemplates(templates)) }
  if (next.background !== null && next.background !== undefined) {
    if (typeof next.background !== 'object') return fail('背景（background）の形ではありません')
    r = setBackground(r.scene, next.background)
    if (!r.ok) return r
  }
  if (next.site !== null && next.site !== undefined) {
    r = setSite(r.scene, next.site)
    if (!r.ok) return r
  }
  // 置けない所を書かなければ無し（AI が書かずにシーンを作れるように）
  if (next.zones !== undefined) {
    if (!Array.isArray(next.zones)) return fail('置けない所の一覧（zones）の形ではありません')
    for (const [i, z] of next.zones.entries()) {
      if (typeof z !== 'object' || z === null) return fail(`${i + 1} 番目の置けない所が置けない所の形ではありません`)
      r = addZone(r.scene, z)
      if (!r.ok) return r
    }
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
  if (!Array.isArray(next.links)) return fail('工程のつなぎの一覧（links）がありません')
  if (next.links.length) {
    r = link(r.scene, next.links)
    if (!r.ok) return r
  }
  // 流れの数値を書かなければ架空の目安（AI が数値を書かずにシーンを作れるように）。書かなかった項目も目安で埋める
  const f =
    next.flow === undefined
      ? DEFAULT_FLOW_SETTINGS
      : typeof next.flow === 'object' && next.flow !== null && !Array.isArray(next.flow)
        ? { ...DEFAULT_FLOW_SETTINGS, ...next.flow }
        : next.flow
  const badF = checkFlow(f, true)
  if (badF) return fail(badF)
  const flow = Object.fromEntries(FLOW_KEYS.map((k) => [k, f[k]])) as FlowSettings
  return { ok: true, scene: { ...r.scene, flow } }
}
