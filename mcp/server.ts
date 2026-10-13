// 手元で動く MCP サーバー（stdio）。Claude Code などが起動し、標準入力に 1 行 1 通の JSON-RPC を流してくる。
// 返事は標準出力に 1 行 1 通。ログは標準エラーにだけ出す（標準出力に混ぜると相手が読めなくなる）。
// 作り方: npm run build:mcp → mcp/dist/server.js。登録の手順は README.md。

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
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

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return
  let msg: unknown
  try {
    msg = JSON.parse(line)
  } catch {
    send(parseError())
    return
  }
  const r = handleMessage(msg, io)
  if (r) send(r)
})

process.stderr.write(`layout-studio MCP サーバーを起動しました（作業フォルダ: ${process.cwd()}）\n`)
