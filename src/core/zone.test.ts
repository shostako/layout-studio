import { describe, expect, it } from 'vitest'
import { summarizeScene } from './aiPrompt'
import { planAiCommands } from './ai'
import { applyCommand, type Command } from './commands'
import { planMetrics } from './compare'
import { findOverlaps, overlappingEquipment } from './overlap'
import { SCENE_VERSION, createEmptyScene, type Equipment, type Scene } from './scene'
import { parseScene, serializeScene } from './sceneFile'
import { sceneExtent } from './site'
import { checkZone, nextZoneId, nextZoneName, zoneFromCorners, type Zone } from './zone'

function ok(scene: Scene, cmd: Command): Scene {
  const r = applyCommand(scene, cmd)
  if (!r.ok) throw new Error(r.error)
  return r.scene
}

const wall: Zone = { id: 'zone-1', name: '防火壁', x: 10000, y: 0, width: 200, height: 20000 }

const eq = (id: string, x: number, y: number): Equipment => ({
  id,
  kind: 'trimming',
  name: id,
  x,
  y,
  width: 1800,
  depth: 1200,
  rotation: 0,
  color: '#888',
  clearance: { top: 500, right: 500, bottom: 500, left: 500 },
})

describe('置けない所', () => {
  it('形を確かめる（幅・奥行は正、名前は空でない）', () => {
    expect(checkZone(wall)).toBeNull()
    expect(checkZone({ ...wall, width: 0 })).not.toBeNull()
    expect(checkZone({ ...wall, height: -1 })).not.toBeNull()
    expect(checkZone({ ...wall, name: ' ' })).not.toBeNull()
    expect(checkZone({ ...wall, x: Number.NaN })).not.toBeNull()
  })

  it('対角の 2 点から長方形にする（向きは問わない）', () => {
    expect(zoneFromCorners('z', 'a', { x: 500, y: 300 }, { x: 100, y: 900 })).toEqual({ id: 'z', name: 'a', x: 100, y: 300, width: 400, height: 600 })
  })

  it('足す・名前と大きさを変える・ずらす・消す。id の重複と見つからない id は断る', () => {
    let s = ok(createEmptyScene(), { type: 'addZone', zone: { ...wall, name: ' 防火壁 ' } })
    expect(s.zones).toEqual([wall])
    expect(applyCommand(s, { type: 'addZone', zone: wall }).ok).toBe(false)
    s = ok(s, { type: 'updateZone', ids: ['zone-1'], changes: { name: '壁', width: 300 } })
    expect(s.zones[0]).toMatchObject({ name: '壁', width: 300, x: 10000 })
    expect(applyCommand(s, { type: 'updateZone', ids: ['zone-1'], changes: { height: 0 } }).ok).toBe(false)
    expect(applyCommand(s, { type: 'updateZone', ids: ['zone-1'], changes: {} }).ok).toBe(false)
    s = ok(s, { type: 'moveZone', ids: ['zone-1'], dx: -100, dy: 50 })
    expect(s.zones[0]).toMatchObject({ x: 9900, y: 50 })
    expect(applyCommand(s, { type: 'removeZone', ids: ['zone-9'] }).ok).toBe(false)
    s = ok(s, { type: 'removeZone', ids: ['zone-1'] })
    expect(s.zones).toEqual([])
  })

  it('次の id と名前は続きの番号', () => {
    const s = ok(createEmptyScene(), { type: 'addZone', zone: { ...wall, id: 'zone-3', name: '置けない所 2' } })
    expect(nextZoneId(s)).toBe('zone-4')
    expect(nextZoneName(s)).toBe('置けない所 3')
    expect(nextZoneName(createEmptyScene())).toBe('置けない所 1')
  })

  it('設備の本体と通路の帯が入ると重なりとして挙げる。余白だけなら挙げない', () => {
    let s = ok(createEmptyScene(), { type: 'addZone', zone: wall })
    // 本体（9100〜10900）が壁に入る
    s = ok(s, { type: 'add', equipment: eq('eq-1', 10000, 5000) })
    // 本体は 8000〜9800 で壁の手前、右の余白（10300 まで）だけが壁に入る。余白は入ってよい
    s = ok(s, { type: 'add', equipment: eq('eq-2', 8900, 12000) })
    s = ok(s, { type: 'addAisle', aisle: { id: 'aisle-1', name: '通路', points: [{ x: 5000, y: 18000 }, { x: 15000, y: 18000 }], width: 1500, closed: false } })
    const o = findOverlaps(s)
    const zone = o.filter((x) => x.kind === 'zone')
    expect(zone).toEqual([{ kind: 'zone', zone: 'zone-1', equipment: 'eq-1', region: { x: 10000, y: 4400, width: 200, height: 1200 } }])
    const za = o.filter((x) => x.kind === 'zoneAisle')
    expect(za).toHaveLength(1)
    expect(za[0]).toMatchObject({ zone: 'zone-1', aisle: 'aisle-1' })
    expect(overlappingEquipment(o)).toEqual(new Set(['eq-1']))
    // 比べる表の「重なり」に数える
    expect(planMetrics(s).overlaps).toBe(2)
  })

  it('AI の要約に置けない所と注意を入れる。AI からは置けない所を変えさせない', () => {
    let s = ok(createEmptyScene(), { type: 'addZone', zone: wall })
    s = ok(s, { type: 'add', equipment: eq('eq-1', 10000, 5000) })
    const sum = summarizeScene(s)
    expect(sum.zones).toEqual([{ id: 'zone-1', name: '防火壁', bounds: { left: 10000, top: 0, right: 10200, bottom: 20000 } }])
    expect(sum.notices.some((n) => n.includes('置けない所') && n.includes('防火壁'))).toBe(true)
    expect(planAiCommands(s, [{ type: 'removeZone', ids: ['zone-1'] }]).ok).toBe(false)
  })

  it('保存して読み直すと同じ。版 9 のファイルは置けない所なしで読む', () => {
    const s = ok(createEmptyScene(), { type: 'addZone', zone: wall })
    const back = parseScene(serializeScene(s))
    if (!back.ok) throw new Error(back.error)
    expect(back.scene.zones).toEqual([wall])
    const { zones: _z, ...v9 } = { ...createEmptyScene(), version: 9 }
    const old = parseScene(JSON.stringify(v9))
    if (!old.ok) throw new Error(old.error)
    expect(old.scene.version).toBe(SCENE_VERSION)
    expect(old.scene.zones).toEqual([])
  })

  it('シーンの差し替えで置けない所を確かめ直す。書かなければ無し', () => {
    const base = createEmptyScene()
    expect(ok(base, { type: 'loadScene', scene: { ...base, zones: [wall] } }).zones).toEqual([wall])
    const { zones: _z, ...noZones } = base
    expect(ok(base, { type: 'loadScene', scene: noZones as Scene }).zones).toEqual([])
    expect(applyCommand(base, { type: 'loadScene', scene: { ...base, zones: [{ ...wall, width: 0 }] } }).ok).toBe(false)
  })

  it('「全体」の範囲に置けない所も入る', () => {
    const s = ok(createEmptyScene(), { type: 'addZone', zone: wall })
    expect(sceneExtent(s)).toEqual({ x: 10000, y: 0, width: 200, height: 20000 })
  })
})
