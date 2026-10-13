// シーン（図面・設備）の型。DOM に触らない。単位は mm、原点は図面の左上、右が x、下が y。

export const SCENE_VERSION = 1

export type Equipment = {
  id: string
  kind: string // 'molding-machine' など。ひな形の種類
  name: string
  x: number
  y: number
  width: number
  depth: number
  rotation: 0 | 90 | 180 | 270
  color: string
}

export type Scene = {
  version: typeof SCENE_VERSION
  equipment: Equipment[]
}

export function createEmptyScene(): Scene {
  return { version: SCENE_VERSION, equipment: [] }
}
