// シーンの JSON ファイル: 書き出しと、読み込み（古い版の変換と中身の確かめ）。DOM に触らない。
// ファイルの中身はシーンそのもの（version・background・equipment）。形を変えるときは SCENE_VERSION を上げ、
// MIGRATIONS に 1 つ前の版から変換する関数を足す。

import { applyCommand } from './commands'
import { SCENE_VERSION, createEmptyScene, type Scene } from './scene'

export type ParseResult = { ok: true; scene: Scene } | { ok: false; error: string }

// MIGRATIONS[n] は版 n のデータを版 n + 1 に変える。今は版 1 しかないので空
export const MIGRATIONS: Record<number, (data: Record<string, unknown>) => Record<string, unknown>> = {}

export function serializeScene(scene: Scene): string {
  return JSON.stringify(scene, null, 2) + '\n'
}

// 版を今の版まで上げる。新しすぎる版と、版の無いものは断る
export function migrate(
  data: unknown,
  migrations = MIGRATIONS,
  current = SCENE_VERSION as number,
): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
  if (typeof data !== 'object' || data === null || Array.isArray(data))
    return { ok: false, error: 'layout-studio のシーンのファイルではありません' }
  let d = data as Record<string, unknown>
  let v = d.version
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1)
    return { ok: false, error: 'ファイルに版（version）がありません。layout-studio のシーンのファイルではないようです' }
  if (v > current) return { ok: false, error: `新しい版（${v}）のファイルです。アプリを新しくしてください（読めるのは版 ${current} まで）` }
  while (v < current) {
    const step = migrations[v]
    if (!step) return { ok: false, error: `版 ${v} から変換できません` }
    d = { ...step(d), version: v + 1 }
    v += 1
  }
  return { ok: true, data: d }
}

export function parseScene(text: string): ParseResult {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { ok: false, error: 'JSON として読めませんでした' }
  }
  const m = migrate(data)
  if (!m.ok) return m
  // 中身の確かめは、シーンを差し替えるコマンドと同じものを使う
  const r = applyCommand(createEmptyScene(), { type: 'loadScene', scene: m.data as unknown as Scene })
  return r.ok ? { ok: true, scene: r.scene } : { ok: false, error: r.error }
}

// 保存するファイルの名前（layout-20261013-1530.json）
export function sceneFileName(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `layout-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.json`
}
