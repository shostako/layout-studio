// 案の一覧: 案を足す・複製する・名前を変える・消す・切り替える。左の欄のいちばん上に置く。
// 案の束は src/core/plans.ts のコマンドだけで変える。開いている案のシーンは editor が持ち、切り替えるときに束へ書き戻す。
// 元に戻す・やり直すの履歴は案ごとに持ち、切り替えると持ち替える（案の追加や削除そのものは履歴に入れない）。
import type { Canvas } from './canvas'
import type { Editor } from './editor'
import { createHistory, type History } from '../core/history'
import { activePlan, applyPlanCommand, createPlanSet, layoutChange, layoutGroups, nextPlanIds, withActiveScene, type PlanCommand, type PlanSet } from '../core/plans'
import { createEmptyScene } from '../core/scene'

export type Plans = {
  // 今の案の束（開いている案は editor の今のシーン）
  current(): PlanSet
  // 案の束（並び・名前・開いている案）が変わるたびに増える。開いている案のシーンの変化では増えない
  revision(): number
  onChange(listener: () => void): void
  // 案のコマンドを通す。失敗したら理由を欄に出して false
  run(cmd: PlanCommand): boolean
  // 案の束をまるごと差し替える（起動時に自動保存から戻すときだけ使う）。履歴は捨てる
  load(set: PlanSet): void
}

export function mountPlans(canvas: Canvas, editor: Editor): Plans {
  let set: PlanSet = createPlanSet(editor.scene())
  let rev = 0
  // 開いていない案の履歴。開いている案の履歴は editor が持つ
  const histories = new Map<string, History>()
  const listeners: (() => void)[] = []

  // ---- 左の欄 ----
  const h = document.createElement('h2')
  h.textContent = '案'
  const box = document.createElement('div')
  box.className = 'plan-panel'
  const list = document.createElement('div')
  list.className = 'plan-list'
  const nameLabel = document.createElement('label')
  nameLabel.className = 'plan-name'
  const nameInput = document.createElement('input')
  nameInput.type = 'text'
  nameInput.title = '開いている案の名前（Enter か欄を離れたときに変える）'
  nameLabel.append('名前', nameInput)
  const row = document.createElement('div')
  row.className = 'actions'
  const mk = (label: string, title: string, onClick: () => void) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = label
    b.title = title
    b.addEventListener('click', onClick)
    row.append(b)
    return b
  }
  const msg = document.createElement('div')
  msg.className = 'hint warn'
  // 基準の設備の並びが、案のレイアウトとして確かめた並びから変わったときに聞く
  const ask = document.createElement('div')
  ask.className = 'layout-change'
  ask.hidden = true
  box.append(list, nameLabel, row, ask, msg)
  canvas.side.prepend(h, box)

  const current = () => withActiveScene(set, editor.scene())

  const run = (cmd: PlanCommand): boolean => {
    const before = current()
    const r = applyPlanCommand(before, cmd)
    if (!r.ok) {
      msg.textContent = r.error
      return false
    }
    msg.textContent = ''
    const prevActive = before.active
    set = r.set
    for (const id of histories.keys()) if (!set.plans.some((p) => p.id === id)) histories.delete(id)
    if (set.active !== prevActive) {
      if (set.plans.some((p) => p.id === prevActive)) histories.set(prevActive, editor.history())
      const next = histories.get(set.active) ?? createHistory(activePlan(set).scene)
      histories.delete(set.active)
      editor.restore(next)
    }
    rev += 1
    for (const f of listeners) f()
    draw()
    return true
  }

  // 空の案は、開いている案の設備の種類の一覧を引き継ぐ（種類を作り込んだ一覧を、案ごとに作り直さずに済むように）
  mk('足す', '空の案を足して開く（設備の種類の一覧は、開いている案のものを写す）', () =>
    run({ type: 'addPlan', id: nextPlanIds(current())[0]!, scene: createEmptyScene(editor.scene().templates) }),
  )
  mk('複製', '開いている案の写しを足して開く', () => {
    const s = current()
    run({ type: 'duplicatePlan', source: s.active, id: nextPlanIds(s)[0]! })
  })
  const delBtn = mk('消す', '開いている案を消す（元に戻せない。確かめてから消す）', () => {
    const p = activePlan(current())
    if (window.confirm(`案「${p.name}」を消します。元に戻せません。`)) run({ type: 'removePlan', id: p.id })
  })

  // 名前は確定したとき（change）に 1 回だけ変える。入力を始めた時点で開いていた案に当てる
  let editing: string | null = null
  nameInput.addEventListener('focus', () => (editing = set.active))
  nameInput.addEventListener('change', () => {
    const id = editing ?? set.active
    if (!run({ type: 'renamePlan', id, name: nameInput.value })) nameInput.value = set.plans.find((p) => p.id === id)?.name ?? ''
  })
  nameInput.addEventListener('blur', () => (editing = null))
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') nameInput.blur()
    e.stopPropagation() // 入力中の Delete や矢印キーをキャンバスの操作にしない
  })

  const planButton = (p: PlanSet['plans'][number]) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = `plan${p.id === set.active ? ' active' : ''}`
    b.textContent = p.name
    b.title = p.id === set.active ? '開いている案' : `案「${p.name}」を開く`
    b.addEventListener('click', () => {
      if (p.id !== set.active) run({ type: 'switchPlan', id: p.id })
    })
    return b
  }
  // 案はレイアウト（基準の設備の並び）ごとにまとめて見せる
  const draw = () => {
    const s = current()
    list.replaceChildren(
      ...layoutGroups(s).flatMap((g) => {
        const head = document.createElement('div')
        head.className = 'layout-head'
        head.textContent = `${g.id}　${g.description}`
        head.title = 'レイアウト（基準の設備の並び）。番号の下が、このレイアウトの案'
        return [head, ...g.plans.map(planButton)]
      }),
    )
    if (document.activeElement !== nameInput) nameInput.value = activePlan(set).name
    delBtn.disabled = set.plans.length <= 1
    drawAsk()
  }

  // 並びが変わったか。基準の設備が無かった案に並べたときは、ほかの案と共有していなければ黙って今の並びにする
  let askKey = ''
  const drawAsk = () => {
    const s = current()
    const ch = layoutChange(s)
    const p = activePlan(s)
    if (ch && p.layout?.signature === '' && !s.plans.some((q) => q !== p && q.layout?.id === p.layout?.id)) {
      run({ type: 'confirmLayout', id: p.id })
      return
    }
    const key = ch ? `${p.id}|${ch.from}|${ch.to}|${ch.description}` : ''
    if (key === askKey) return
    askKey = key
    ask.hidden = !ch
    if (!ch) return ask.replaceChildren()
    const text = document.createElement('div')
    text.textContent = `基準の設備の並びが ${ch.from} から変わりました（今: ${ch.description}）。新しいレイアウトにしますか。`
    const acts = document.createElement('div')
    acts.className = 'actions'
    const yes = document.createElement('button')
    yes.type = 'button'
    yes.textContent = ch.existing ? `${ch.to} に移す` : `新しいレイアウト ${ch.to} にする`
    yes.title = ch.existing ? `同じ並びのレイアウト ${ch.to} にこの案を移す` : 'この案を新しいレイアウトにする（ほかの案は今のレイアウトのまま）'
    yes.addEventListener('click', () => run({ type: 'setPlanLayout', id: p.id, layout: ch.to }))
    const no = document.createElement('button')
    no.type = 'button'
    no.textContent = `${ch.from} のままにする`
    no.title = `この案を ${ch.from} のままにし、今の並びを ${ch.from} の並びとして覚える`
    no.addEventListener('click', () => run({ type: 'confirmLayout', id: p.id }))
    acts.append(yes, no)
    ask.replaceChildren(text, acts)
  }
  // 開いている案の並びが変わったら、まとめの見出し（説明）も書き直す
  let groupsKey = ''
  editor.onRender(() => {
    const key = layoutGroups(current())
      .map((g) => `${g.id}:${g.description}`)
      .join('|')
    if (key !== groupsKey) {
      groupsKey = key
      draw()
    } else drawAsk()
  })
  draw()

  return {
    current,
    revision: () => rev,
    onChange: (f) => listeners.push(f),
    run,
    load: (next) => {
      set = next
      histories.clear()
      editor.reset(activePlan(set).scene)
      rev += 1
      for (const f of listeners) f()
      draw()
    },
  }
}
