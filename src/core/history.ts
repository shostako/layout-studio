// 元に戻す・やり直す。コマンドを通したシーンの移り変わりを、シーンの写しの列で持つ。
// シーンは書き換えずに作り直す（変わらない部分は前の版と共有する）ので、写しを持っても重くない。

import { applyCommand, type Command, type CommandResult } from './commands'
import type { Scene } from './scene'

export const HISTORY_LIMIT = 200

export type History = {
  past: Scene[] // 古い順
  present: Scene
  future: Scene[] // 次にやり直すものが先頭
}

export function createHistory(scene: Scene): History {
  return { past: [], present: scene, future: [] }
}

export type ExecuteResult = { ok: true; history: History } | { ok: false; error: string; history: History }

// コマンドを実行して履歴に積む。やり直しの列は捨てる。失敗したら履歴は変えない
export function execute(history: History, cmd: Command): ExecuteResult {
  const result: CommandResult = applyCommand(history.present, cmd)
  if (!result.ok) return { ok: false, error: result.error, history }
  const past = [...history.past, history.present].slice(-HISTORY_LIMIT)
  return { ok: true, history: { past, present: result.scene, future: [] } }
}

export function canUndo(history: History): boolean {
  return history.past.length > 0
}

export function canRedo(history: History): boolean {
  return history.future.length > 0
}

export function undo(history: History): History {
  const prev = history.past[history.past.length - 1]
  if (!prev) return history
  return { past: history.past.slice(0, -1), present: prev, future: [history.present, ...history.future] }
}

export function redo(history: History): History {
  const next = history.future[0]
  if (!next) return history
  return { past: [...history.past, history.present], present: next, future: history.future.slice(1) }
}
