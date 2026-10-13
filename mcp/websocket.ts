// 画面とつなぐための、ごく小さな WebSocket（RFC 6455）。ライブラリを入れずに、使う分だけ書いた。
// 受け付けるのは文字の 1 通（分割されたものもつなぐ）・ping・close。こちらから送るのは文字の 1 通だけ（マスクしない）。
// ここは入出力に触らない純関数だけ。ソケットの扱いは live.ts。

import { createHash } from 'node:crypto'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

// 握手の返事に入れる Sec-WebSocket-Accept
export function acceptKey(key: string): string {
  return createHash('sha1').update(key + GUID).digest('base64')
}

export const OP = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa } as const

// 1 通の上限（バイト）。案の束は背景の画像を抜いて送るので、これで足りる
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024

// サーバーから送る 1 フレーム（FIN つき、マスクなし）
export function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const n = payload.length
  let head: Buffer
  if (n < 126) {
    head = Buffer.from([0x80 | opcode, n])
  } else if (n < 0x10000) {
    head = Buffer.alloc(4)
    head[0] = 0x80 | opcode
    head[1] = 126
    head.writeUInt16BE(n, 2)
  } else {
    head = Buffer.alloc(10)
    head[0] = 0x80 | opcode
    head[1] = 127
    head.writeBigUInt64BE(BigInt(n), 2)
  }
  return Buffer.concat([head, payload])
}

export type Frame = { opcode: number; fin: boolean; payload: Buffer }
export type Event = { type: 'text'; text: string } | { type: 'ping'; payload: Buffer } | { type: 'close' } | { type: 'error'; error: string }

// 届いたバイトをためてフレームに切り、文字の 1 通・ping・close にする。ブラウザから届くフレームは必ずマスクされている
export function createReader() {
  let buf: Buffer = Buffer.alloc(0)
  let parts: Buffer[] | null = null
  let partsLen = 0

  const nextFrame = (): Frame | 'wait' | string => {
    if (buf.length < 2) return 'wait'
    const b0 = buf[0]!
    const b1 = buf[1]!
    const fin = (b0 & 0x80) !== 0
    const opcode = b0 & 0x0f
    if ((b1 & 0x80) === 0) return 'マスクされていないフレームを受けました'
    let len = b1 & 0x7f
    let off = 2
    if (len === 126) {
      if (buf.length < 4) return 'wait'
      len = buf.readUInt16BE(2)
      off = 4
    } else if (len === 127) {
      if (buf.length < 10) return 'wait'
      const big = buf.readBigUInt64BE(2)
      if (big > BigInt(MAX_MESSAGE_BYTES)) return '大きすぎる 1 通を受けました'
      len = Number(big)
      off = 10
    }
    if (len > MAX_MESSAGE_BYTES) return '大きすぎる 1 通を受けました'
    if (buf.length < off + 4 + len) return 'wait'
    const mask = buf.subarray(off, off + 4)
    const payload = Buffer.alloc(len)
    for (let i = 0; i < len; i++) payload[i] = buf[off + 4 + i]! ^ mask[i & 3]!
    buf = buf.subarray(off + 4 + len)
    return { opcode, fin, payload }
  }

  return {
    push(chunk: Buffer): Event[] {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
      const events: Event[] = []
      for (;;) {
        const f = nextFrame()
        if (f === 'wait') break
        if (typeof f === 'string') {
          events.push({ type: 'error', error: f })
          break
        }
        if (f.opcode === OP.ping) events.push({ type: 'ping', payload: f.payload })
        else if (f.opcode === OP.pong) continue
        else if (f.opcode === OP.close) {
          events.push({ type: 'close' })
          break
        } else if (f.opcode === OP.text || f.opcode === OP.continuation) {
          if (f.opcode === OP.text) {
            parts = []
            partsLen = 0
          }
          if (!parts) {
            events.push({ type: 'error', error: '続きのフレームだけを受けました' })
            break
          }
          parts.push(f.payload)
          partsLen += f.payload.length
          if (partsLen > MAX_MESSAGE_BYTES) {
            events.push({ type: 'error', error: '大きすぎる 1 通を受けました' })
            break
          }
          if (f.fin) {
            events.push({ type: 'text', text: Buffer.concat(parts).toString('utf8') })
            parts = null
          }
        } else {
          events.push({ type: 'error', error: '文字でない 1 通は受けません' })
          break
        }
      }
      return events
    },
  }
}

// つないでよいページか。ブラウザは必ず Origin を付ける。手元（localhost・127.0.0.1・[::1]）のページと、
// 環境変数で足した Origin だけを通す。Origin の無いものはブラウザでない手元のプログラムなので通す
// （手元のプログラムは、そもそもファイルも読み書きできる）。よそのサイトのページが勝手につなぐのを防ぐため
export function originAllowed(origin: string | undefined, extra: readonly string[] = []): boolean {
  if (origin === undefined) return true
  if (extra.includes(origin)) return true
  try {
    const u = new URL(origin)
    return (u.protocol === 'http:' || u.protocol === 'https:') && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
  } catch {
    return false
  }
}
