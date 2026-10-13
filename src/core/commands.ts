// シーンを変える操作（コマンド）。画面・保存・元に戻す・AI の操作は、すべてここを通る。
// applyCommand は純関数で、元のシーンを書き換えず、新しいシーンを返す。

import { calibrate, checkBackground, type Background } from './background'
import type { Equipment, Rotation, Scene } from './scene'
import type { Point } from './viewport'

export type Command =
  | { type: 'add'; equipment: Equipment } // 設備を置く。id は呼ぶ側が決める（nextEquipmentId）
  | { type: 'move'; ids: string[]; dx: number; dy: number } // 設備をずらす（mm）
  | { type: 'rotate'; ids: string[]; quarterTurns: number } // 各設備の中心のまわりに 90 度 × n 回す。正が時計回り
  | { type: 'remove'; ids: string[] } // 設備を消す
  | { type: 'setBackground'; background: Background | null } // 背景の画像を置く・差し替える・外す（null）
  | { type: 'calibrateBackground'; a: Point; b: Point; distance: number } // 図面の上の 2 点が distance mm 離れているとして縮尺を合わせる。a は動かない
  | { type: 'moveBackground'; dx: number; dy: number } // 背景をずらす（mm）

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
    case 'setBackground':
      return setBackground(scene, cmd.background)
    case 'calibrateBackground':
      return calibrateBackground(scene, cmd.a, cmd.b, cmd.distance)
    case 'moveBackground':
      return moveBackground(scene, cmd.dx, cmd.dy)
  }
}

const ROTATIONS: readonly Rotation[] = [0, 90, 180, 270]

function fail(error: string): CommandResult {
  return { ok: false, error }
}

function add(scene: Scene, eq: Equipment): CommandResult {
  if (!eq.id) return fail('設備の id が空です')
  if (scene.equipment.some((e) => e.id === eq.id)) return fail(`設備の id が重複しています: ${eq.id}`)
  if (!Number.isFinite(eq.x) || !Number.isFinite(eq.y)) return fail('設備の位置が数ではありません')
  if (!(eq.width > 0 && eq.depth > 0 && Number.isFinite(eq.width) && Number.isFinite(eq.depth)))
    return fail('設備の幅と奥行は正の数にしてください')
  if (!ROTATIONS.includes(eq.rotation)) return fail('回転は 0・90・180・270 のどれかです')
  return { ok: true, scene: { ...scene, equipment: [...scene.equipment, { ...eq }] } }
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

function setBackground(scene: Scene, bg: Background | null): CommandResult {
  if (bg === null) return { ok: true, scene: { ...scene, background: null } }
  const bad = checkBackground(bg)
  if (bad) return fail(bad)
  return { ok: true, scene: { ...scene, background: { ...bg } } }
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
