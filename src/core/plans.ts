// 案（プラン）: 検討の途中の配置を何本も持ち、切り替える。DOM に触らない。
// 案ごとにシーンを 1 つ持つ。案の追加・複製・名前の変更・削除・切り替えは、シーンのコマンドと同じく純関数のコマンドにする。
// 比べる数字（面積・余白の床面積）は src/core/compare.ts で出す。
// 案はどれか 1 つのレイアウト（基準の設備の並び。src/core/layout.ts）に属する。layout.signature は、その案をそのレイアウトとして
// 確かめた時の並び。今の並びと違えば、画面が「新しいレイアウトにしますか」と聞く（setPlanLayout・confirmLayout）。

import { describeLayout, layoutSignature, nextLayoutId } from './layout'
import { createEmptyScene, type Scene } from './scene'

export type PlanLayout = { id: string; signature: string }

export type Plan = {
  id: string
  name: string
  scene: Scene
  layout?: PlanLayout // 無ければ、束を作る・読むときに並びから振る（withLayouts）
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
  | { type: 'importPlans'; plans: Plan[] } // ファイルの案を後ろに足す（id は振り直し、名前は重なれば番号を付ける。レイアウトは並びが同じものに合わせ、無ければ新しい番号）
  | { type: 'setPlanLayout'; id: string; layout?: string } // 案を今の並びでレイアウトに入れ直す。layout を書かなければ、同じ並びのレイアウトか新しい番号
  | { type: 'confirmLayout'; id: string } // 案のレイアウトの番号はそのままで、今の並びを、そのレイアウトとして確かめた並びにする

export type PlanResult = { ok: true; set: PlanSet } | { ok: false; error: string }

export function createPlanSet(scene: Scene = createEmptyScene()): PlanSet {
  return withLayouts({ plans: [{ id: 'plan-1', name: '案 1', scene }], active: 'plan-1' })
}

// 同じ並び（確かめた並び）のレイアウトの番号。無ければ null
function layoutFor(plans: readonly Plan[], signature: string): string | null {
  return plans.find((p) => p.layout?.signature === signature)?.layout?.id ?? null
}

// レイアウトの無い案に、並びから番号を振る（同じ並びの案があればその番号、無ければ次の番号）
export function withLayouts(set: PlanSet): PlanSet {
  if (set.plans.every((p) => p.layout)) return set
  const done: Plan[] = []
  for (const p of set.plans) {
    if (p.layout) {
      done.push(p)
      continue
    }
    const signature = layoutSignature(p.scene)
    const id = layoutFor([...done, ...set.plans.filter((q) => q.layout)], signature) ?? nextLayoutId([...done, ...set.plans].flatMap((q) => (q.layout ? [q.layout.id] : [])))
    done.push({ ...p, layout: { id, signature } })
  }
  return { ...set, plans: done }
}

export type LayoutGroup = { id: string; description: string; plans: Plan[] }

// レイアウトごとの案（番号の順。案の並びは一覧の順）。説明は、確かめた並びのままの案のシーンから書く
export function layoutGroups(set: PlanSet): LayoutGroup[] {
  const ids = [...new Set(set.plans.map((p) => p.layout?.id ?? '?'))].sort()
  return ids.map((id) => {
    const plans = set.plans.filter((p) => (p.layout?.id ?? '?') === id)
    const base = plans.find((p) => p.layout && layoutSignature(p.scene) === p.layout.signature) ?? plans[0]!
    return { id, description: describeLayout(base.scene), plans }
  })
}

// 開いている案の並びが、確かめた並びから変わったか。変わっていれば、移れる先（同じ並びのレイアウト）か新しい番号を返す
export function layoutChange(set: PlanSet, id = set.active): { from: string; to: string; existing: boolean; description: string } | null {
  const p = set.plans.find((q) => q.id === id)
  if (!p?.layout) return null
  const signature = layoutSignature(p.scene)
  if (signature === p.layout.signature) return null
  const others = set.plans.filter((q) => q !== p)
  const match = layoutFor(others, signature)
  const to = match ?? nextLayoutId(set.plans.flatMap((q) => (q.layout ? [q.layout.id] : [])))
  return { from: p.layout.id, to, existing: match !== null, description: describeLayout(p.scene) }
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
      return { ok: true, set: withLayouts({ plans: [...set.plans, plan], active: cmd.id }) }
    }
    case 'duplicatePlan': {
      const src = find(set, cmd.source)
      if (!src) return fail(`案が見つかりません: ${cmd.source}`)
      const bad = checkNewId(set, cmd.id)
      if (bad) return fail(bad)
      // シーンは書き換えずに作り直すので、写しは同じシーンを指したままでよい
      const copy = { id: cmd.id, name: uniquePlanName(names, `${src.name} の写し`), scene: src.scene, layout: src.layout }
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
    case 'setPlanLayout': {
      const p = find(set, cmd.id)
      if (!p) return fail(`案が見つかりません: ${cmd.id}`)
      const signature = layoutSignature(p.scene)
      const others = set.plans.filter((q) => q !== p)
      let id = cmd.layout
      if (id !== undefined && (typeof id !== 'string' || !/^L\d+$/.test(id))) return fail('レイアウトの番号は L01 の形です')
      id ??= layoutFor(others, signature) ?? nextLayoutId(set.plans.flatMap((q) => (q.layout ? [q.layout.id] : [])))
      return { ok: true, set: { ...set, plans: set.plans.map((q) => (q === p ? { ...q, layout: { id: id!, signature } } : q)) } }
    }
    case 'confirmLayout': {
      const p = find(set, cmd.id)
      if (!p) return fail(`案が見つかりません: ${cmd.id}`)
      const id = p.layout?.id ?? nextLayoutId(set.plans.flatMap((q) => (q.layout ? [q.layout.id] : [])))
      return { ok: true, set: { ...set, plans: set.plans.map((q) => (q === p ? { ...q, layout: { id, signature: layoutSignature(p.scene) } } : q)) } }
    }
    case 'importPlans': {
      if (!Array.isArray(cmd.plans) || cmd.plans.length === 0) return fail('足す案がありません')
      const ids = nextPlanIds(set, cmd.plans.length)
      const used = [...names]
      // ファイルのレイアウトの番号は、今の束の番号と重なるので付け直す。確かめた並びが同じレイアウトがあればその番号、無ければ次の番号
      const remap = new Map<string, string>()
      let layoutIds = set.plans.flatMap((p) => (p.layout ? [p.layout.id] : []))
      const added: Plan[] = cmd.plans.map((p, i) => {
        const name = uniquePlanName(used, p.name.trim() || '案')
        used.push(name)
        const signature = p.layout?.signature ?? layoutSignature(p.scene)
        const key = p.layout ? `id:${p.layout.id}` : `sig:${signature}`
        let id = remap.get(key)
        if (!id) {
          id = layoutFor(set.plans, signature) ?? nextLayoutId(layoutIds)
          remap.set(key, id)
          layoutIds = [...layoutIds, id]
        }
        return { id: ids[i]!, name, scene: p.scene, layout: { id, signature } }
      })
      return { ok: true, set: { plans: [...set.plans, ...added], active: added[0]!.id } }
    }
  }
}
