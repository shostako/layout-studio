import { describe, expect, it } from 'vitest'
import { prefKeys } from './prefs'

describe('prefKeys', () => {
  it('このアプリの設定の鍵だけを選ぶ', () => {
    expect(prefKeys(['layout-studio:theme', 'other', 'layout-studio:grid-default', 'layout-studiox'])).toEqual([
      'layout-studio:theme',
      'layout-studio:grid-default',
    ])
  })
})
