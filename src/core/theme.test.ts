import { describe, expect, it } from 'vitest'
import { nextTheme, parseTheme, themeAttribute } from './theme'

describe('色の見え方', () => {
  it('自動 → ライト → ダーク → 自動 と回る', () => {
    expect(nextTheme('auto')).toBe('light')
    expect(nextTheme('light')).toBe('dark')
    expect(nextTheme('dark')).toBe('auto')
  })

  it('保存してあった値を読む。知らない値・無い値は自動', () => {
    expect(parseTheme('light')).toBe('light')
    expect(parseTheme('dark')).toBe('dark')
    expect(parseTheme('auto')).toBe('auto')
    expect(parseTheme(null)).toBe('auto')
    expect(parseTheme('blue')).toBe('auto')
  })

  it('自動のときは data-theme を付けない', () => {
    expect(themeAttribute('auto')).toBeNull()
    expect(themeAttribute('light')).toBe('light')
    expect(themeAttribute('dark')).toBe('dark')
  })
})
