// このブラウザに覚えておく見え方・操作の設定（localStorage の鍵）。DOM に触らない。
// 鍵はすべて PREF_PREFIX で始める。「初期設定に戻す」はこの前置きの鍵だけを消す（図面と案は IndexedDB にあり、消さない）。

export const PREF_PREFIX = 'layout-studio:'

// 並んだ鍵のうち、このアプリの設定の鍵
export function prefKeys(keys: readonly string[]): string[] {
  return keys.filter((k) => k.startsWith(PREF_PREFIX))
}
