// 手元で動く MCP サーバー（stdio）。Claude Code などが起動し、標準入力に 1 行 1 通の JSON-RPC を流してくる。
// 返事は標準出力に 1 行 1 通。ログは標準エラーにだけ出す（標準出力に混ぜると相手が読めなくなる）。
// あわせて 127.0.0.1 で WebSocket を待ち、画面の「AI とつなぐ」でつながった画面に指示をその場で当てる（live.ts）。
// ポートは環境変数 LAYOUT_STUDIO_PORT（既定 47615）、手元以外のページを通すときは LAYOUT_STUDIO_ORIGINS（, 区切り）。
// 作り方: npm run build:mcp → mcp/dist/server.js。登録の手順は README.md。

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { LIVE_DEFAULT_PORT } from '../src/core/live'
import { startLiveServer } from './live'
import { handleMessage, parseError, type Message } from './protocol'
import type { FileIo } from './tools'

const io: FileIo = {
  read(path) {
    const p = resolve(path)
    return existsSync(p) ? readFileSync(p, 'utf8') : null
  },
  // 途中で止まっても元のファイルが壊れないよう、隣に書いてから置き換える
  write(path, text) {
    const p = resolve(path)
    const tmp = `${p}.tmp-${process.pid}`
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, p)
  },
}

const send = (m: Message) => process.stdout.write(JSON.stringify(m) + '\n')
const log = (text: string) => process.stderr.write(`layout-studio: ${text}\n`)

const port = Number(process.env.LAYOUT_STUDIO_PORT ?? LIVE_DEFAULT_PORT)
const screen = startLiveServer({
  port: Number.isInteger(port) && port > 0 && port < 65536 ? port : LIVE_DEFAULT_PORT,
  origins: (process.env.LAYOUT_STUDIO_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean),
  log,
})
const ctx = { io, screen }

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return
  let msg: unknown
  try {
    msg = JSON.parse(line)
  } catch {
    send(parseError())
    return
  }
  // 画面の答えを待つ道具があるので、返事は届いた順とは限らない（JSON-RPC は id で対応を取る）
  void handleMessage(msg, ctx).then((r) => r && send(r))
}).on('close', () => {
  screen.close()
})

log(`MCP サーバーを起動しました（作業フォルダ: ${process.cwd()}）`)
