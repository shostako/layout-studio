// 設備の種類（ひな形）の編集: 名前・寸法・色・余白・役割を変える、足す、消す、工程の順に並べ替える、組（射出成形など）を足す。
// 一覧はシーンが持ち（案ごと）、変えるときは setTemplates のコマンドを editor.run に通す（元に戻せる）。
// 置いてある設備は変えない（寸法を変えたいときは、選択中の欄で変える）。
import type { Canvas } from './canvas'
import type { Editor } from './editor'
import type { Clearance } from '../core/scene'
import { PRESETS, ROLES, ROLE_LABELS, mergePreset, nextTemplateKind, type EquipmentTemplate, type Role } from '../core/templates'

const SIDES: { key: keyof Clearance; label: string }[] = [
  { key: 'top', label: '上' },
  { key: 'right', label: '右' },
  { key: 'bottom', label: '下' },
  { key: 'left', label: '左' },
]

const ROLE_HINTS: Record<Role, string> = {
  anchor: 'レイアウトの骨組みになる設備（射出成形の組では成形機）',
  mounted: '別の種類の設備の上に重ねて置く。つないだ載り先との重なりは注意にしない',
  buffer: '満杯で AGV を呼ぶ（流れの再生でストッカーとして扱う）',
}

export function mountTemplates(canvas: Canvas, editor: Editor): void {
  const panel = document.createElement('details')
  panel.className = 'kind-panel'
  const summary = document.createElement('summary')
  summary.textContent = '設備の種類を編集'
  summary.title = '置く設備の種類（ひな形）の名前・寸法・色・余白・役割を変える、足す、消す、工程の順に並べ替える。案ごとに保存し、元に戻せる'
  panel.append(summary)

  const pick = document.createElement('select')
  pick.title = '編集する種類'
  const props = document.createElement('div')
  props.className = 'props'
  const mkRow = (label: string, input: HTMLElement, title = '') => {
    const l = document.createElement('label')
    l.append(label, input)
    if (title) l.title = title
    props.append(l)
    return l
  }
  const mkNumber = (min: string, step: string) => {
    const i = document.createElement('input')
    i.type = 'number'
    i.min = min
    i.step = step
    return i
  }
  const nameInput = document.createElement('input')
  nameInput.type = 'text'
  const widthInput = mkNumber('1', '10')
  const depthInput = mkNumber('1', '10')
  const colorInput = document.createElement('input')
  colorInput.type = 'color'
  const roleSelect = document.createElement('select')
  for (const [value, label] of [['', 'なし'], ...ROLES.map((r) => [r, ROLE_LABELS[r]])] as [string, string][]) {
    const o = document.createElement('option')
    o.value = value
    o.textContent = label
    roleSelect.append(o)
  }
  const mountSelect = document.createElement('select')
  mkRow('種類', pick)
  mkRow('名前', nameInput)
  mkRow('幅 mm', widthInput, '回転 0 のときの x 方向。これから置くものに使う')
  mkRow('奥行 mm', depthInput, '回転 0 のときの y 方向')
  mkRow('色', colorInput)
  const clearanceBox = document.createElement('span')
  clearanceBox.className = 'clearance-inputs'
  const clearanceInputs = new Map<keyof Clearance, HTMLInputElement>()
  for (const { key, label } of SIDES) {
    const i = mkNumber('0', '100')
    i.title = `余白の${label}（mm）`
    clearanceInputs.set(key, i)
    clearanceBox.append(i)
  }
  const clearanceRow = mkRow('余白', clearanceBox, '置いたときの保守用の余白（mm）。上・右・下・左')
  clearanceRow.className = 'clearance-row'
  const roleRow = mkRow('役割', roleSelect, ROLES.map((r) => `${ROLE_LABELS[r]}: ${ROLE_HINTS[r]}`).join('\n'))
  const mountRow = mkRow('載り先', mountSelect, '「載る」の種類を、どの種類の上に置くか')

  const actions = document.createElement('div')
  actions.className = 'actions'
  const mkButton = (label: string, title: string, onClick: () => void) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = label
    b.title = title
    b.addEventListener('click', () => {
      onClick()
      b.blur()
    })
    actions.append(b)
    return b
  }
  const upBtn = mkButton('↑', '工程の順で 1 つ前へ（「工程の順につなぐ」の順になる）', () => moveBy(-1))
  const downBtn = mkButton('↓', '工程の順で 1 つ後へ', () => moveBy(1))
  const delBtn = mkButton('消す', 'この種類を一覧から消す（置いてある設備の種類は消せない）', () => removeCurrent())
  mkButton('足す', '新しい種類を一覧の最後に足す', () => addKind())
  for (const p of PRESETS)
    mkButton(`${p.name}の組`, `${p.name}の組の種類のうち、一覧に無いものを足す（あるものは今の値のまま）`, () => {
      const cur = editor.scene().templates
      const next = mergePreset(cur, p.templates)
      if (next.length === cur.length) note.textContent = `${p.name}の組の種類は、もう全部あります`
      else if (editor.run({ type: 'setTemplates', templates: next })) note.textContent = `${p.name}の組から ${next.length - cur.length} 種類を足した`
    })
  const note = document.createElement('div')
  note.className = 'hint'
  panel.append(props, actions, note)

  // 置く設備のひな形の一覧のすぐ下に置く
  const list = canvas.side.querySelector('.templates')
  if (list) list.after(panel)
  else canvas.side.append(panel)

  let current = '' // 編集している種類の kind
  const templates = () => editor.scene().templates
  const cur = (): EquipmentTemplate | undefined => templates().find((t) => t.kind === current)

  // 今の種類を変えた一覧を通す。断られたら欄を今の値に戻す
  const change = (f: (t: EquipmentTemplate) => EquipmentTemplate) => {
    const t = cur()
    if (!t) return
    note.textContent = ''
    if (!editor.run({ type: 'setTemplates', templates: templates().map((x) => (x.kind === t.kind ? f(x) : x)) })) fill(true)
  }
  const moveBy = (d: number) => {
    const list = [...templates()]
    const i = list.findIndex((t) => t.kind === current)
    const j = i + d
    if (i < 0 || j < 0 || j >= list.length) return
    ;[list[i], list[j]] = [list[j]!, list[i]!]
    editor.run({ type: 'setTemplates', templates: list })
  }
  const removeCurrent = () => {
    const t = cur()
    if (!t) return
    // 載り先にしている種類は、載る種類の役割を外してから消す
    const users = templates().filter((x) => x.role === 'mounted' && x.mountsOn === t.kind)
    if (users.length) {
      note.textContent = `${users.map((x) => x.name).join('、')}の載り先なので消せません（先に役割を変えてください）`
      return
    }
    if (editor.run({ type: 'setTemplates', templates: templates().filter((x) => x.kind !== t.kind) })) note.textContent = `${t.name}を一覧から消した`
  }
  const addKind = () => {
    const list = templates()
    const kind = nextTemplateKind(list)
    let n = 1
    while (list.some((t) => t.name === `新しい設備 ${n}`)) n++
    const t: EquipmentTemplate = {
      kind,
      name: `新しい設備 ${n}`,
      width: 2000,
      depth: 2000,
      color: '#8a8f99',
      clearance: { top: 500, right: 500, bottom: 500, left: 500 },
    }
    if (editor.run({ type: 'setTemplates', templates: [...list, t] })) {
      current = kind
      note.textContent = '最後に足した。名前と寸法を変えてください'
      fill(true)
      nameInput.focus()
      nameInput.select()
    }
  }

  nameInput.addEventListener('change', () => {
    const v = nameInput.value.trim()
    if (v) change((t) => ({ ...t, name: v }))
    else fill(true)
  })
  for (const [input, key] of [
    [widthInput, 'width'],
    [depthInput, 'depth'],
  ] as const)
    input.addEventListener('change', () => {
      const v = Number(input.value)
      if (v > 0 && Number.isFinite(v)) change((t) => ({ ...t, [key]: v }))
      else fill(true)
    })
  colorInput.addEventListener('change', () => change((t) => ({ ...t, color: colorInput.value })))
  for (const [key, input] of clearanceInputs)
    input.addEventListener('change', () => {
      const v = Number(input.value)
      if (input.value !== '' && v >= 0 && Number.isFinite(v)) change((t) => ({ ...t, clearance: { ...t.clearance, [key]: v } }))
      else fill(true)
    })
  roleSelect.addEventListener('change', () => {
    const role = roleSelect.value as Role | ''
    change((t) => {
      const { role: _r, mountsOn: _m, ...rest } = t
      if (!role) return rest
      if (role !== 'mounted') return { ...rest, role }
      // 載り先は、自分以外で最初の基準の種類（無ければ自分以外の先頭）
      const others = templates().filter((x) => x.kind !== t.kind)
      const on = others.find((x) => x.role === 'anchor') ?? others[0]
      return on ? { ...rest, role, mountsOn: on.kind } : { ...rest, role }
    })
  })
  mountSelect.addEventListener('change', () => change((t) => ({ ...t, mountsOn: mountSelect.value })))
  pick.addEventListener('change', () => {
    current = pick.value
    note.textContent = ''
    fill(true)
  })

  // 欄を今の一覧に合わせる。force でなければ、入力中の欄は書き換えない
  let shownFor: readonly EquipmentTemplate[] | null = null
  function fill(force = false) {
    const list = templates()
    if (!force && list === shownFor) return
    shownFor = list
    if (!list.some((t) => t.kind === current)) current = list[0]?.kind ?? ''
    pick.replaceChildren(
      ...list.map((t, i) => {
        const o = document.createElement('option')
        o.value = t.kind
        o.textContent = `${i + 1}. ${t.name}${t.role ? `（${ROLE_LABELS[t.role]}）` : ''}`
        return o
      }),
    )
    pick.value = current
    const t = cur()
    props.querySelectorAll('input, select').forEach((el) => ((el as HTMLInputElement).disabled = !t && el !== pick))
    for (const b of [upBtn, downBtn, delBtn]) b.disabled = !t
    if (!t) return
    const i = list.indexOf(t)
    upBtn.disabled = i <= 0
    downBtn.disabled = i >= list.length - 1
    nameInput.value = t.name
    widthInput.value = String(t.width)
    depthInput.value = String(t.depth)
    colorInput.value = t.color
    for (const [key, input] of clearanceInputs) input.value = String(t.clearance[key])
    roleSelect.value = t.role ?? ''
    roleSelect.title = t.role ? ROLE_HINTS[t.role] : 'ふつうの設備'
    mountRow.hidden = t.role !== 'mounted'
    mountSelect.replaceChildren(
      ...list
        .filter((x) => x.kind !== t.kind)
        .map((x) => {
          const o = document.createElement('option')
          o.value = x.kind
          o.textContent = x.name
          return o
        }),
    )
    mountSelect.value = t.mountsOn ?? ''
    roleRow.hidden = false
  }
  editor.onRender(() => fill())
  editor.onReset(() => {
    note.textContent = ''
    fill(true)
  })
  fill(true)
}
