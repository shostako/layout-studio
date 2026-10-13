// AI で動かす（試し）: 頼みを AI に送り、応答（コマンドの列）を確かめて並べ、「当てる」で 1 回の操作として当てる。
// 確かめと直しは src/core/ai.ts の純関数。当てるのは batch コマンドで、元に戻す 1 回で全部戻る。
// いまは本物の AI ではなく、決まった応答を返す差し替え部品（src/core/aiStub.ts）を使う。外へは何も送らない。
// 応答の JSON を手で貼って試すこともできる（ほかの AI のチャットで作った応答を確かめるなど）。
import type { Canvas } from './canvas'
import type { Editor } from './editor'
import { parseAiReply, planAiCommands, type AiPlan, type AiReply } from '../core/ai'
import { STUB_EXAMPLES, createStubClient, type AiClient } from '../core/aiStub'
import type { Scene } from '../core/scene'

export function mountAi(canvas: Canvas, editor: Editor, client: AiClient = createStubClient()): void {
  const h = document.createElement('h2')
  h.textContent = 'AI で動かす（試し）'
  const panel = document.createElement('div')
  panel.className = 'ai-panel'
  const note = document.createElement('div')
  note.className = 'hint'
  note.textContent = `いまの相手: ${client.name}。外へは何も送らない。`

  const examples = document.createElement('select')
  examples.title = '差し替え部品が答えられる頼み方の例'
  const first = document.createElement('option')
  first.value = ''
  first.textContent = '例から選ぶ…'
  examples.append(first)
  for (const ex of STUB_EXAMPLES) {
    const o = document.createElement('option')
    o.value = ex
    o.textContent = ex
    examples.append(o)
  }
  const request = document.createElement('textarea')
  request.rows = 2
  request.placeholder = '例: 成形機を3台、2000 mm 間隔で横に並べて'
  examples.addEventListener('change', () => {
    if (examples.value) request.value = examples.value
    examples.value = ''
  })
  const sendBtn = document.createElement('button')
  sendBtn.type = 'button'
  sendBtn.textContent = '頼む'
  sendBtn.title = '頼みを送り、応答の指示を並べる（まだ当てない）。Ctrl+Enter でも送る'
  const sendRow = document.createElement('div')
  sendRow.className = 'actions'
  sendRow.append(sendBtn)

  // 応答の JSON を手で貼る
  const paste = document.createElement('details')
  const pasteSummary = document.createElement('summary')
  pasteSummary.textContent = '応答の JSON を貼って確かめる'
  const pasteArea = document.createElement('textarea')
  pasteArea.rows = 4
  pasteArea.placeholder = '{ "message": "…", "commands": [ { "type": "place", "kind": "molding-machine", "x": 5000, "y": 5000 } ] }'
  const pasteBtn = document.createElement('button')
  pasteBtn.type = 'button'
  pasteBtn.textContent = '確かめる'
  const pasteRow = document.createElement('div')
  pasteRow.className = 'actions'
  pasteRow.append(pasteBtn)
  paste.append(pasteSummary, pasteArea, pasteRow)

  // 応答と指示の並び
  const result = document.createElement('div')
  result.className = 'ai-result'
  const answer = document.createElement('div')
  answer.className = 'ai-answer'
  const steps = document.createElement('ol')
  steps.className = 'ai-steps'
  const error = document.createElement('div')
  error.className = 'message'
  const applyRow = document.createElement('div')
  applyRow.className = 'actions'
  const applyBtn = document.createElement('button')
  applyBtn.type = 'button'
  applyBtn.textContent = '当てる'
  applyBtn.title = '並んだ指示をまとめて当てる（元に戻す 1 回で全部戻る）'
  const dropBtn = document.createElement('button')
  dropBtn.type = 'button'
  dropBtn.textContent = 'やめる'
  applyRow.append(applyBtn, dropBtn)
  const done = document.createElement('div')
  done.className = 'hint'
  result.append(answer, steps, error, applyRow, done)

  panel.append(note, examples, request, sendRow, paste, result)
  canvas.side.append(h, panel)

  // 届いた応答。シーンが変わるたびに今のシーンで確かめ直す（id の振り方や、指示の相手が消えたかが変わるため）
  let reply: AiReply | null = null
  let plan: AiPlan | null = null
  let planned: Scene | null = null
  let busy = false

  const replan = () => {
    if (!reply) return
    const s = editor.scene()
    if (planned === s) return
    planned = s
    plan = planAiCommands(s, reply.commands)
  }

  const draw = () => {
    replan()
    sendBtn.disabled = busy
    answer.textContent = reply?.message ?? ''
    steps.replaceChildren()
    error.textContent = ''
    if (plan && plan.ok) {
      for (const st of plan.steps) {
        const li = document.createElement('li')
        li.textContent = st.text
        steps.append(li)
      }
    } else if (plan) {
      error.textContent = `${plan.error}。どの指示も当てていません。`
    }
    const canApply = !!plan && plan.ok && plan.steps.length > 0
    applyRow.hidden = !reply
    applyBtn.disabled = !canApply
  }

  const take = (text: string) => {
    done.textContent = ''
    const p = parseAiReply(text)
    if (!p.ok) {
      reply = null
      plan = null
      planned = null
      draw()
      error.textContent = `応答を読めませんでした: ${p.error}`
      return
    }
    reply = p.reply
    planned = null
    draw()
  }

  const send = async () => {
    const text = request.value.trim()
    if (!text || busy) return
    busy = true
    draw()
    try {
      take(await client.ask(text, editor.scene()))
    } catch (e) {
      reply = null
      plan = null
      draw()
      error.textContent = `AI に頼めませんでした: ${e instanceof Error ? e.message : String(e)}`
    } finally {
      busy = false
      sendBtn.disabled = false
    }
  }

  const clear = () => {
    reply = null
    plan = null
    planned = null
    draw()
  }

  sendBtn.addEventListener('click', () => void send())
  request.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      void send()
    }
  })
  pasteBtn.addEventListener('click', () => take(pasteArea.value))
  dropBtn.addEventListener('click', () => {
    clear()
    done.textContent = ''
  })
  applyBtn.addEventListener('click', () => {
    replan()
    if (!plan || !plan.ok || plan.steps.length === 0) return draw()
    const before = new Set(editor.scene().equipment.map((e) => e.id))
    const n = plan.steps.length
    if (!editor.run({ type: 'batch', commands: plan.steps.map((s) => s.command) })) return draw()
    // 新しく置いた設備を選ぶ（どこに置かれたか分かるように）
    const added = editor.scene().equipment.filter((e) => !before.has(e.id)).map((e) => e.id)
    if (added.length) editor.select(added)
    clear()
    done.textContent = `${n} 個の指示を当てました。元に戻す（Ctrl+Z）1 回で全部戻ります。`
  })

  editor.onRender(() => {
    if (reply && planned !== editor.scene()) draw()
  })
  draw()
}
