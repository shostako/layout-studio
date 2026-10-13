// 案（プラン）: 検討の途中の配置を何本も持ち、切り替える。DOM に触らない。
// 案ごとにシーンを 1 つ持つ。案の追加・複製・名前の変更・削除・切り替えは、シーンのコマンドと同じく純関数のコマンドにする。
// 比べる数字（面積・余白の床面積）は src/core/compare.ts で出す。

import { createEmptyScene, type Scene } from './scene'

export type Plan = {
  id: string
  name: string
  scene: Scene
}

export type PlanSet = {
  plans: Plan[] // 並びは画面の一覧の順
  active: string // 今開いている案の id
}

export type PlanCommand =
  | { type: 'addPlan'; id: string; name?: string; scene?: Scene } // 名前を書かなければ「案 n」。シーンを書かなければ空
  | { type: 'duplicatePlan'; source: string; id: string } // 写しを元の案のすぐ後に足す。名前は「元の名前 の写し」
  | { type: 'renamePlan'; id: string; name: string }
  | { type: 'removePlan'; id: string } // 最後の 1 つは消せない
  | { type: 'switchPlan'; id: string }
  | { type: 'importPlans'; plans: Plan[] } // ファイルの案を後ろに足す（id は振り直し、名前は重なれば番号を付ける）

export type PlanResult = { ok: true; set: PlanSet } | { ok: false; error: string }

export function createPlanSet(scene: Scene = createEmptyScene()): PlanSet {
  return { plans: [{ id: 'plan-1', name: '案 1', scene }], active: 'plan-1' }
}

export function activePlan(set: PlanSet): Plan {
  return set.plans.find((p) => p.id === set.active) ?? set.plans[0]!
}

// 今開いている案のシーンを差し替えた案の束（画面で編集中のシーンを書き戻すのに使う）
export function withActiveScene(set: PlanSet, scene: Scene): PlanSet {
  const cur = activePlan(set)
  if (cur.scene === scene) return set
  return { ...set, plans: set.plans.map((p) => (p.id === cur.id ? { ...p, scene } : p)) }
}

// まだ使われていない案の id を n 個（'plan-1', 'plan-2', ...）
export function nextPlanIds(set: PlanSet, n = 1): string[] {
  let max = 0
  for (const p of set.plans) {
    const m = /^plan-(\d+)$/.exec(p.id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return Array.from({ length: n }, (_, i) => `plan-${max + 1 + i}`)
}

// 新しい案の名前「案 n」。使われている「案 k」の最大 + 1
export function nextPlanName(set: PlanSet): string {
  let max = 0
  for (const p of set.plans) {
    const m = /^案 (\d+)$/.exec(p.name)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `案 ${max + 1}`
}

// 他の案と重ならない名前。重なれば「名前 2」「名前 3」…
export function uniquePlanName(names: Iterable<string>, name: string): string {
  const used = new Set(names)
  if (!used.has(name)) return name
  for (let k = 2; ; k++) if (!used.has(`${name} ${k}`)) return `${name} ${k}`
}

function fail(error: string): PlanResult {
  return { ok: false, error }
}

function find(set: PlanSet, id: string): Plan | undefined {
  return set.plans.find((p) => p.id === id)
}

function checkNewId(set: PlanSet, id: string): string | null {
  if (typeof id !== 'string' || !id) return '案の id が空です'
  if (find(set, id)) return `案の id が重複しています: ${id}`
  return null
}

export function applyPlanCommand(set: PlanSet, cmd: PlanCommand): PlanResult {
  const names = set.plans.map((p) => p.name)
  switch (cmd.type) {
    case 'addPlan': {
      const bad = checkNewId(set, cmd.id)
      if (bad) return fail(bad)
      const name = cmd.name === undefined ? nextPlanName(set) : cmd.name.trim()
      if (!name) return fail('案の名前が空です')
      if (names.includes(name)) return fail(`同じ名前の案があります: ${name}`)
      const plan = { id: cmd.id, name, scene: cmd.scene ?? createEmptyScene() }
      return { ok: true, set: { plans: [...set.plans, plan], active: cmd.id } }
    }
    case 'duplicatePlan': {
      const src = find(set, cmd.source)
      if (!src) return fail(`案が見つかりません: ${cmd.source}`)
      const bad = checkNewId(set, cmd.id)
      if (bad) return fail(bad)
      // シーンは書き換えずに作り直すので、写しは同じシーンを指したままでよい
      const copy = { id: cmd.id, name: uniquePlanName(names, `${src.name} の写し`), scene: src.scene }
      const i = set.plans.indexOf(src)
      return { ok: true, set: { plans: [...set.plans.slice(0, i + 1), copy, ...set.plans.slice(i + 1)], active: cmd.id } }
    }
    case 'renamePlan': {
      const p = find(set, cmd.id)
      if (!p) return fail(`案が見つかりません: ${cmd.id}`)
      const name = typeof cmd.name === 'string' ? cmd.name.trim() : ''
      if (!name) return fail('案の名前が空です')
      if (name === p.name) return { ok: true, set }
      if (names.includes(name)) return fail(`同じ名前の案があります: ${name}`)
      return { ok: true, set: { ...set, plans: set.plans.map((q) => (q === p ? { ...q, name } : q)) } }
    }
    case 'removePlan': {
      const p = find(set, cmd.id)
      if (!p) return fail(`案が見つかりません: ${cmd.id}`)
      if (set.plans.length === 1) return fail('最後の案は消せません')
      const i = set.plans.indexOf(p)
      const plans = set.plans.filter((q) => q !== p)
      // 開いている案を消したら、すぐ前（先頭なら次）の案を開く
      const active = set.active === p.id ? plans[Math.max(0, i - 1)]!.id : set.active
      return { ok: true, set: { plans, active } }
    }
    case 'switchPlan':
      if (!find(set, cmd.id)) return fail(`案が見つかりません: ${cmd.id}`)
      return { ok: true, set: { ...set, active: cmd.id } }
    case 'importPlans': {
      if (!Array.isArray(cmd.plans) || cmd.plans.length === 0) return fail('足す案がありません')
      const ids = nextPlanIds(set, cmd.plans.length)
      const used = [...names]
      const added = cmd.plans.map((p, i) => {
        const name = uniquePlanName(used, p.name.trim() || '案')
        used.push(name)
        return { id: ids[i]!, name, scene: p.scene }
      })
      return { ok: true, set: { plans: [...set.plans, ...added], active: added[0]!.id } }
    }
  }
}
