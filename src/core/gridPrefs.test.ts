import { describe, expect, it } from 'vitest'
import { FACTORY_GRID_PREFS, formatGridPrefs, parseGridPrefs } from './gridPrefs'

describe('マス目とスナップの既定', () => {
  it('覚えた値を読み戻す', () => {
    expect(parseGridPrefs(formatGridPrefs({ grid: 100, snap: 10 }))).toEqual({ grid: 100, snap: 10 })
  })
  it('何も無ければ工場の既定（自動・100 mm）', () => {
    expect(parseGridPrefs(null)).toEqual(FACTORY_GRID_PREFS)
    expect(FACTORY_GRID_PREFS).toEqual({ grid: 0, snap: 100 })
  })
  it('壊れた文字列や選べない値は、その項目だけ工場の既定にする', () => {
    expect(parseGridPrefs('{')).toEqual(FACTORY_GRID_PREFS)
    expect(parseGridPrefs('[1,2]')).toEqual(FACTORY_GRID_PREFS)
    expect(parseGridPrefs(JSON.stringify({ grid: 123, snap: 50 }))).toEqual({ grid: 0, snap: 50 })
    expect(parseGridPrefs(JSON.stringify({ grid: 500, snap: '10' }))).toEqual({ grid: 500, snap: 100 })
  })
})
