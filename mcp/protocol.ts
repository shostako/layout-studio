// MCP（Model Context Protocol）の受け答え: JSON-RPC 2.0 の 1 通を受け、返す 1 通を作る（通知なら null）。入出力は ctx を通す。
// 使うのは initialize・ping・tools/list・tools/call だけ。stdio では 1 行に 1 通の JSON を流す（server.ts）。

import { TOOLS, callTool, type Context } from './tools'

// 受け付ける MCP の版。相手が言った版が知っているものならそれを、知らなければいちばん新しいものを返す
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const
export const SERVER_INFO = { name: 'layout-studio', version: '0.1.0' }

const INSTRUCTIONS =
  'layout-studio（工場の設備レイアウトの図面エディタ）の案の JSON ファイルを読み、配置の指示を確かめて当てる道具です。' +
  'まず get_instructions で指示の書き方を読み、summarize で今の配置を見て、check_commands で確かめてから apply_commands で当ててください。' +
  '利用者が画面の「AI とつなぐ」を押していれば、file を省くとその画面に当て、その場で図面に出ます（元に戻す 1 回で戻ります）。' +
  '長さは mm、原点は図面の左上で右が +x、下が +y です。'

type Id = string | number | null
export type Message = { jsonrpc: '2.0'; id: Id; result?: unknown; error?: { code: number; message: string } }

const reply = (id: Id, result: unknown): Message => ({ jsonrpc: '2.0', id, result })
const failure = (id: Id, code: number, message: string): Message => ({ jsonrpc: '2.0', id, error: { code, message } })

export const PARSE_ERROR = -32700
const INVALID_REQUEST = -32600
const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602

export function parseError(): Message {
  return failure(null, PARSE_ERROR, 'JSON として読めませんでした')
}

export async function handleMessage(msg: unknown, ctx: Context): Promise<Message | null> {
  if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) return failure(null, INVALID_REQUEST, '要求の形ではありません')
  const m = msg as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown }
  const hasId = 'id' in m && (typeof m.id === 'string' || typeof m.id === 'number')
  const id = hasId ? (m.id as string | number) : null
  if (m.jsonrpc !== '2.0' || typeof m.method !== 'string') return hasId || !('method' in m) ? failure(id, INVALID_REQUEST, '要求の形ではありません') : null
  // id の無いものは通知（notifications/initialized など）。返事はしない
  if (!hasId) return null
  const params = (typeof m.params === 'object' && m.params !== null ? m.params : {}) as Record<string, unknown>
  switch (m.method) {
    case 'initialize': {
      const asked = params.protocolVersion
      const version = PROTOCOL_VERSIONS.find((v) => v === asked) ?? PROTOCOL_VERSIONS[0]
      return reply(id, { protocolVersion: version, capabilities: { tools: {} }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS })
    }
    case 'ping':
      return reply(id, {})
    case 'tools/list':
      return reply(id, { tools: TOOLS })
    case 'tools/call': {
      const name = params.name
      if (typeof name !== 'string') return failure(id, INVALID_PARAMS, '道具の名前（name）がありません')
      if (!TOOLS.some((t) => t.name === name)) return failure(id, INVALID_PARAMS, `道具がありません: ${name}`)
      const args = typeof params.arguments === 'object' && params.arguments !== null ? (params.arguments as Record<string, unknown>) : {}
      let r
      try {
        r = await callTool(name, args, ctx)
      } catch (e) {
        r = { text: `道具の中で失敗しました: ${e instanceof Error ? e.message : String(e)}`, isError: true }
      }
      return reply(id, { content: [{ type: 'text', text: r.text }], isError: r.isError })
    }
    default:
      return failure(id, METHOD_NOT_FOUND, `知らない要求です: ${m.method}`)
  }
}
