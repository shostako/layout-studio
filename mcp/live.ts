// 画面へのその場の反映: localhost で WebSocket を待ち、つながった画面に頼み（state・apply）を送って答えを待つ。
// つなぐ画面は 1 つ。新しい画面がつながったら、前の画面は切る（いちばん最近「AI とつなぐ」を押した画面に当てる）。
// 127.0.0.1 だけで待ち、よそのサイトのページからはつながせない（originAllowed）。

import { createServer, type IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { LiveAsk, LiveResponse } from '../src/core/live'
import type { Screen } from './tools'
import { OP, acceptKey, createReader, encodeFrame, originAllowed } from './websocket'

// 画面の答えを待つ長さ（ms）
const TIMEOUT_MS = 10_000
// 別の画面がつながったので前の画面を切るときの close の番号（src/ui/live.ts は、これで切られたらつなぎ直さない）
const REPLACED_CODE = 4001
const closeFrame = (code: number) => {
  const b = Buffer.alloc(2)
  b.writeUInt16BE(code)
  return encodeFrame(OP.close, b)
}

type Pending = { resolve(r: LiveResponse): void; timer: ReturnType<typeof setTimeout> }

export type LiveServer = Screen & { close(): void }

export function startLiveServer(opts: { port: number; origins?: readonly string[]; log(text: string): void }): LiveServer {
  let socket: Duplex | null = null
  let nextId = 1
  const pending = new Map<number, Pending>()

  const failAll = (error: string) => {
    for (const [id, p] of pending) {
      clearTimeout(p.timer)
      p.resolve({ id, ok: false, error })
    }
    pending.clear()
  }

  const drop = (s: Duplex, why: string) => {
    if (socket !== s) return
    socket = null
    failAll(why)
    opts.log(`画面との接続が切れました（${why}）`)
  }

  const http = createServer((_req, res) => {
    res.writeHead(426, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('layout-studio の画面から「AI とつなぐ」でつないでください（WebSocket）\n')
  })

  http.on('upgrade', (req: IncomingMessage, s: Duplex) => {
    const key = req.headers['sec-websocket-key']
    const origin = req.headers.origin
    if (req.headers.upgrade?.toLowerCase() !== 'websocket' || typeof key !== 'string') {
      s.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      return
    }
    if (!originAllowed(origin, opts.origins)) {
      opts.log(`つなぐのを断りました（Origin: ${origin}）。足すときは LAYOUT_STUDIO_ORIGINS に書く`)
      s.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      return
    }
    s.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' + `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
    )
    if (socket) {
      const old = socket
      drop(old, '別の画面がつながりました')
      old.end(closeFrame(REPLACED_CODE))
    }
    socket = s
    opts.log(`画面がつながりました（${origin ?? 'Origin なし'}）`)
    const reader = createReader()
    s.on('data', (chunk: Buffer) => {
      for (const ev of reader.push(chunk)) {
        if (ev.type === 'ping') s.write(encodeFrame(OP.pong, ev.payload))
        else if (ev.type === 'close') {
          drop(s, '画面が閉じました')
          s.end(closeFrame(1000))
        } else if (ev.type === 'error') {
          drop(s, ev.error)
          s.destroy()
        } else receive(ev.text)
      }
    })
    s.on('close', () => drop(s, '接続が閉じました'))
    s.on('error', () => drop(s, '接続で失敗しました'))
  })

  const receive = (text: string) => {
    let m: LiveResponse
    try {
      m = JSON.parse(text) as LiveResponse
    } catch {
      return
    }
    const p = typeof m?.id === 'number' ? pending.get(m.id) : undefined
    if (!p) return
    pending.delete(m.id)
    clearTimeout(p.timer)
    p.resolve(m)
  }

  http.on('error', (e: NodeJS.ErrnoException) => {
    opts.log(
      e.code === 'EADDRINUSE'
        ? `ポート ${opts.port} はほかで使われています。画面へのその場の反映は使えません（ファイルの道具は使えます）。別の番号は LAYOUT_STUDIO_PORT で`
        : `画面を待てませんでした: ${e.message}`,
    )
  })
  http.listen(opts.port, '127.0.0.1', () => opts.log(`画面からの接続を ws://127.0.0.1:${opts.port} で待っています`))
  // 待っているだけでは Node を終わらせないようにする（stdin が閉じたら終わる）
  http.unref()

  const send = (req: LiveAsk): Promise<LiveResponse> => {
    const s = socket
    const id = nextId++
    if (!s) return Promise.resolve({ id, ok: false, error: '画面がつながっていません' })
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        resolve({ id, ok: false, error: '画面から答えがありません（タブが隠れて止まっている、または閉じた）' })
      }, TIMEOUT_MS)
      pending.set(id, { resolve, timer })
      s.write(encodeFrame(OP.text, Buffer.from(JSON.stringify({ ...req, id }), 'utf8')))
    })
  }

  return {
    connected: () => socket !== null,
    request: send,
    close: () => {
      failAll('MCP サーバーを止めました')
      socket?.destroy()
      http.close()
    },
  }
}
