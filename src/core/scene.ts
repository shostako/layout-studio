// シーン（図面・設備）の型。DOM に触らない。単位は mm、原点は図面の左上、右が x、下が y。

export const SCENE_VERSION = 1

export type Rotation = 0 | 90 | 180 | 270

export type Equipment = {
  id: string
  kind: string // 'molding-machine' など。ひな形の種類
  name: string
  // 設備の中心の座標。回転は中心のまわりで行うので、回しても x, y は変わらない
  x: number
  y: number
  width: number // 回転 0 のときの x 方向の長さ
  depth: number // 回転 0 のときの y 方向の長さ
  rotation: Rotation // 時計回り（画面の見た目で）
  color: string
}

export type Scene = {
  version: typeof SCENE_VERSION
  equipment: Equipment[]
}

export function createEmptyScene(): Scene {
  return { version: SCENE_VERSION, equipment: [] }
}

// 回転を考えた、図面の上で占める外接の長方形（左上と大きさ）
export function footprint(eq: Equipment): { x: number; y: number; width: number; height: number } {
  const turned = eq.rotation === 90 || eq.rotation === 270
  const width = turned ? eq.depth : eq.width
  const height = turned ? eq.width : eq.depth
  return { x: eq.x - width / 2, y: eq.y - height / 2, width, height }
}

// まだ使われていない設備の id を返す（'eq-1', 'eq-2', ...）。コマンドは id を受け取る側にし、純関数のままにする
export function nextEquipmentId(scene: Scene): string {
  let max = 0
  for (const eq of scene.equipment) {
    const m = /^eq-(\d+)$/.exec(eq.id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `eq-${max + 1}`
}
