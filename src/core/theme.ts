// 色の見え方（自動・ライト・ダーク）。見る人ごとの好みで、案の中身ではないのでシーンにもコマンドにも入れない（表示範囲と同じ）。
// 自動は OS の設定（prefers-color-scheme）に従う。DOM に触らない。

export type ThemeChoice = 'auto' | 'light' | 'dark'

export const THEME_ORDER: readonly ThemeChoice[] = ['auto', 'light', 'dark']

export const THEME_LABEL: Record<ThemeChoice, string> = { auto: '自動', light: 'ライト', dark: 'ダーク' }

// 保存してあった値を読む。知らない値や無いときは自動
export function parseTheme(value: unknown): ThemeChoice {
  return value === 'light' || value === 'dark' ? value : 'auto'
}

// ボタンを押すたびに 自動 → ライト → ダーク → 自動 と回す
export function nextTheme(t: ThemeChoice): ThemeChoice {
  return THEME_ORDER[(THEME_ORDER.indexOf(t) + 1) % THEME_ORDER.length]!
}

// html の data-theme に付ける値。自動は付けない（CSS が OS の設定で決める）
export function themeAttribute(t: ThemeChoice): 'light' | 'dark' | null {
  return t === 'auto' ? null : t
}
