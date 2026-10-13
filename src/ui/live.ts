// AI とつなぐ: 手元の MCP サーバー（mcp/）に WebSocket でつなぎ、AI が当てた指示をその場で図面に出す。
// サーバーからの頼み（src/core/live.ts）に答えるだけで、外のサーバーへは何も送らない。つなぐ先は 127.0.0.1 だけ。
// 受けた指示は「AI で動かす」と同じ確かめを通し、案のコマンド（切り替え・写し）と batch コマンド 1 つで当てる。元に戻す 1 回で戻る。
import type { Canvas } from './canvas'
import type { Editor } from './editor'
import type { Plans } from './plans'
import { LIVE_DEFAULT_PORT, liveSnapshot, parseLiveRequest, planLiveApply, type LiveRequest, type LiveResponse } from '../core/live'

// サーバーが「別の画面がつながった」ので切るときの close の番号（mcp/live.ts と同じ）
const REPLACED_CODE = 4001
// サーバーが見つからないとき、つなぎ直すまでの間（ms）
const RETRY_MS = 3000

export function mountLive(canvas: Canvas, editor: Editor, plans: Plans): void {
  const h = document.createElement('h2')
  h.textContent = 'AI とつなぐ（手元の MCP）'
  const panel = document.createElement('div')
  panel.className = 'ai-panel live-panel'
  const row = document.createElement('div')
  row.className = 'actions'
  const portLabel = document.createElement('label')
  const port = document.createElement('input')
  port.type = 'number'
  port.min = '1'
  port.max = '65535'
  port.value = String(LIVE_DEFAULT_PORT)
  port.title = 'MCP サーバーが待つポート（既定 47615。変えたときは LAYOUT_STUDIO_PORT と同じ番号）'
  port.addEventListener('keydown', (e) => e.stopPropagation())
  portLabel.append('ポート', port)
  const btn = document.createElement('button')
  btn.type = 'button'
  row.append(btn, portLabel)
  const status = document.createElement('div')
  status.className = 'hint'
  const last = document.createElement('div')
  last.className = 'hint'
  panel.append(row, status, last)
  canvas.side.append(h, panel)

  let wanted = false
  let ws: WebSocket | null = null
  let retry: ReturnType<typeof setTimeout> | null = null

  const draw = (text: string) => {
    btn.textContent = wanted ? '切る' : 'AI とつなぐ'
    btn.title = wanted ? 'MCP サーバーとの接続を切る' : `ws://127.0.0.1:${port.value} の MCP サーバーにつなぐ。AI が当てた指示がその場で図面に出る`
    port.disabled = wanted
    status.textContent = text
  }

  const respond = (r: LiveResponse) => ws?.send(JSON.stringify(r))

  const apply = (req: Extract<LiveRequest, { type: 'apply' }>): LiveResponse => {
    const p = planLiveApply(plans.current(), req)
    if (!p.ok) return { id: req.id, ok: false, error: p.error }
    for (const c of p.plan.planCommands) if (!plans.run(c)) return { id: req.id, ok: false, error: `案を${c.type === 'switchPlan' ? '開け' : '作れ'}ませんでした` }
    const before = new Set(editor.scene().equipment.map((e) => e.id))
    if (!editor.run(p.plan.command)) return { id: req.id, ok: false, error: '画面で当てられませんでした（案の写しは残っています）' }
    // 新しく置いた設備を選ぶ（どこに置かれたか分かるように）
    const added = editor.scene().equipment.filter((e) => !before.has(e.id)).map((e) => e.id)
    if (added.length) editor.select(added)
    const n = p.plan.steps.length
    last.textContent = `AI が「${p.plan.plan.name}」に ${n} 個の指示を当てました。元に戻す（Ctrl+Z）1 回で全部戻ります。`
    return { id: req.id, ok: true, plans: liveSnapshot(plans.current()), applied: { plan: p.plan.plan, steps: p.plan.steps } }
  }

  const receive = (text: string) => {
    const r = parseLiveRequest(text)
    if (!r.ok) {
      if (r.id !== null) respond({ id: r.id, ok: false, error: r.error })
      return
    }
    const req = r.request
    if (req.type === 'state') respond({ id: req.id, ok: true, plans: liveSnapshot(plans.current()) })
    else respond(apply(req))
  }

  const connect = () => {
    retry = null
    if (!wanted) return
    const url = `ws://127.0.0.1:${port.value}`
    let opened = false
    let s: WebSocket
    try {
      s = new WebSocket(url)
    } catch (e) {
      wanted = false
      draw(`つなげませんでした: ${e instanceof Error ? e.message : String(e)}`)
      return
    }
    ws = s
    draw(`${url} の MCP サーバーを探しています…`)
    s.onopen = () => {
      opened = true
      draw(`つながっています（${url}）。AI に「画面の案に」と頼むと、その場で図面に出ます。`)
    }
    s.onmessage = (e) => {
      if (typeof e.data === 'string') receive(e.data)
    }
    s.onclose = (e) => {
      if (ws !== s) return
      ws = null
      if (!wanted) return
      if (e.code === REPLACED_CODE) {
        wanted = false
        draw('別の画面（タブ）がつながったので切りました。こちらで使うときはもう一度「AI とつなぐ」。')
        return
      }
      draw(
        opened
          ? 'MCP サーバーとの接続が切れました。つなぎ直しています…'
          : `${url} に MCP サーバーが見つかりません。AI（Claude Code など）を起動すると、つながります。待っています…`,
      )
      retry = setTimeout(connect, RETRY_MS)
    }
  }

  btn.addEventListener('click', () => {
    wanted = !wanted
    if (retry) clearTimeout(retry)
    retry = null
    if (wanted) return connect()
    const s = ws
    ws = null
    s?.close()
    draw('つないでいません。')
  })
  draw('つないでいません。MCP サーバーの登録は README の「AI から動かす」。')
}
