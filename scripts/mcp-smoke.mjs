// 作った MCP サーバー（mcp/dist/server.js）を本当に起動し、stdio で受け答えできるかを確かめる。ci.sh が呼ぶ。
// 一時フォルダに空のシーンを置き、initialize → tools/list → apply_commands → summarize を流す。
// 続けて画面の代わりに WebSocket でつなぎ、file を省いた summarize が画面の案を読むことを確かめる。
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'layout-mcp-'))
const file = join(dir, 'plan.json')
// 版 5 のシーン（flow が無い）を置く。読むときに版 6 へ上がることも確かめる
writeFileSync(file, JSON.stringify({ version: 5, background: null, site: null, equipment: [], aisles: [], links: [] }))

const PORT = 47691
const server = spawn(process.execPath, ['mcp/dist/server.js'], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, LAYOUT_STUDIO_PORT: String(PORT) },
})
const pending = new Map()
let buf = ''
server.stdout.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
    const m = JSON.parse(line)
    pending.get(m.id)?.(m)
  }
})
let next = 1
const call = (method, params) =>
  new Promise((res, rej) => {
    const id = next++
    const t = setTimeout(() => rej(new Error(`返事がありません: ${method}`)), 5000)
    pending.set(id, (m) => (clearTimeout(t), res(m)))
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
const check = (cond, what) => {
  if (!cond) throw new Error(`mcp-smoke: ${what}`)
}

try {
  const init = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } })
  check(init.result?.serverInfo?.name === 'layout-studio', 'initialize')
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  const list = await call('tools/list', {})
  const names = list.result.tools.map((t) => t.name).join(',')
  check(names === 'get_instructions,summarize,check_commands,apply_commands', `tools/list: ${names}`)
  const commands = [{ type: 'place', kind: 'molding-machine', x: 10000, y: 5000 }]
  const applied = await call('tools/call', { name: 'apply_commands', arguments: { file, commands } })
  check(applied.result.isError === false, `apply_commands: ${applied.result.content[0].text}`)
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  check(saved.version === 9 && saved.equipment.length === 1, 'ファイルに書き戻せていない')
  const sum = await call('tools/call', { name: 'summarize', arguments: { file } })
  check(JSON.parse(sum.result.content[0].text).scene.equipment[0].id === 'eq-1', 'summarize')
  // 画面の代わり: state を聞かれたら、成形機 1 台の案の束を答える
  const plans = JSON.stringify({ format: 'layout-studio/plans', version: 1, active: 'p', plans: [{ id: 'p', name: '画面の案', scene: saved }] })
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { headers: { Origin: 'http://localhost:5173' } })
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data))
    ws.send(JSON.stringify(m.type === 'state' ? { id: m.id, ok: true, plans } : { id: m.id, ok: false, error: 'smoke' }))
  }
  await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = () => rej(new Error('mcp-smoke: 画面としてつなげない')))))
  await new Promise((res) => setTimeout(res, 100))
  const live = await call('tools/call', { name: 'summarize', arguments: {} })
  const liveOut = JSON.parse(live.result.content[0].text)
  check(liveOut.screen === true && liveOut.plan.name === '画面の案' && liveOut.metrics.equipmentCount === 1, `画面の summarize: ${live.result.content[0].text}`)
  ws.close()
  console.log('mcp-smoke: ok')
} finally {
  server.kill()
  rmSync(dir, { recursive: true, force: true })
}
