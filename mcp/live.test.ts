import { request } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { startLiveServer, type LiveServer } from './live'
import { OP, acceptKey, createReader, encodeFrame, originAllowed } from './websocket'

// ブラウザが送る形（マスクつき）のフレーム
function clientFrame(opcode: number, text: string, fin = true): Buffer {
  const payload = Buffer.from(text, 'utf8')
  const mask = Buffer.from([1, 2, 3, 4])
  const n = payload.length
  const head = n < 126 ? Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | n]) : Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | 126, n >> 8, n & 0xff])
  return Buffer.concat([head, mask, Buffer.from(payload.map((b, i) => b ^ mask[i & 3]!))])
}

describe('WebSocket のフレーム', () => {
  it('握手の鍵は RFC 6455 の例どおり', () => {
    expect(acceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
  })

  it('マスクを外して文字の 1 通にする。分かれて届いても、続きのフレームでもつなぐ', () => {
    const r = createReader()
    const long = 'あ'.repeat(100) // 300 バイト（長さは 2 バイトで書く形）
    const bytes = Buffer.concat([clientFrame(OP.text, 'こんにちは'), clientFrame(OP.text, long)])
    expect(r.push(bytes.subarray(0, 5))).toEqual([])
    expect(r.push(bytes.subarray(5))).toEqual([
      { type: 'text', text: 'こんにちは' },
      { type: 'text', text: long },
    ])
    expect(r.push(clientFrame(OP.text, '{"a":', false))).toEqual([])
    expect(r.push(clientFrame(OP.continuation, '1}'))).toEqual([{ type: 'text', text: '{"a":1}' }])
    expect(r.push(clientFrame(OP.close, ''))).toEqual([{ type: 'close' }])
  })

  it('マスクの無いフレームは断る', () => {
    expect(createReader().push(encodeFrame(OP.text, Buffer.from('x')))).toMatchObject([{ type: 'error' }])
  })

  it('送るフレームは長さに応じて 1・2・8 バイトで長さを書く', () => {
    expect(encodeFrame(OP.text, Buffer.alloc(10)).subarray(0, 2)).toEqual(Buffer.from([0x81, 10]))
    expect(encodeFrame(OP.text, Buffer.alloc(300)).subarray(0, 4)).toEqual(Buffer.from([0x81, 126, 1, 44]))
    expect(encodeFrame(OP.text, Buffer.alloc(70000))[1]).toBe(127)
  })

  it('つないでよいのは手元のページと、足した Origin だけ', () => {
    expect(originAllowed('http://localhost:5173')).toBe(true)
    expect(originAllowed('http://127.0.0.1:4173')).toBe(true)
    expect(originAllowed(undefined)).toBe(true)
    expect(originAllowed('https://evil.example')).toBe(false)
    expect(originAllowed('null')).toBe(false)
    expect(originAllowed('https://tools.example', ['https://tools.example'])).toBe(true)
  })
})

describe('画面を待つサーバー', () => {
  const PORT = 47690
  let server: LiveServer | null = null
  afterEach(() => {
    server?.close()
    server = null
  })

  const start = async () => {
    const s = startLiveServer({ port: PORT, log: () => {} })
    server = s
    await new Promise((r) => setTimeout(r, 50))
    return s
  }

  it('つながった画面に頼みを送り、答えを受ける', async () => {
    const s = await start()
    expect(s.connected()).toBe(false)
    expect(await s.request({ type: 'state' })).toMatchObject({ ok: false, error: '画面がつながっていません' })
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`)
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as { id: number; type: string }
      ws.send(JSON.stringify({ id: m.id, ok: true, plans: `got ${m.type}` }))
    }
    await new Promise((r) => (ws.onopen = r))
    await new Promise((r) => setTimeout(r, 20))
    expect(s.connected()).toBe(true)
    expect(await s.request({ type: 'state' })).toMatchObject({ ok: true, plans: 'got state' })
    ws.close()
    await new Promise((r) => setTimeout(r, 50))
    expect(s.connected()).toBe(false)
  })

  it('よそのサイトのページからの接続は断る', async () => {
    await start()
    const status = await new Promise<number | undefined>((resolve) => {
      const req = request({
        host: '127.0.0.1',
        port: PORT,
        headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13', Origin: 'https://evil.example' },
      })
      req.on('response', (res) => resolve(res.statusCode))
      req.on('upgrade', () => resolve(101))
      req.on('error', () => resolve(undefined))
      req.end()
    })
    expect(status).toBe(403)
    expect(server!.connected()).toBe(false)
  })
})
