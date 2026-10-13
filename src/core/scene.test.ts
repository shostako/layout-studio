import { describe, expect, it } from 'vitest'
import { SCENE_VERSION, createEmptyScene } from './scene'

describe('createEmptyScene', () => {
  it('設備が空で、現行の版を持つ', () => {
    const scene = createEmptyScene()
    expect(scene.version).toBe(SCENE_VERSION)
    expect(scene.equipment).toEqual([])
  })
})
