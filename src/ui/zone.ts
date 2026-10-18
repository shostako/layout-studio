// 置けない所（防火壁・柱・キュービクルなど）: 図面の上で 2 点を選んで描く、寸法で置く、欄で名前・位置・大きさを直す、消す。
// シーンの変更は editor.run（コマンド）を通す。描いている途中の 1 点目は画面の状態で、2 点目で 1 回だけ addZone を出す。
import type { Canvas } from './canvas'
import type { Editor, Tool } from './editor'
import { snapValue } from '../core/placement'
import { nextZoneId, nextZoneName, zoneFromCorners, type Zone } from '../core/zone'
import type { Point } from '../core/viewport'

const SVG_NS = 'http://www.w3.org/2000/svg'
const MARK_PX = 4
// 名前の文字が小さすぎるとき（mm）は書かない（細い壁など）
const LABEL_MIN_MM = 60

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v))
  return el
}

export function mountZones(canvas: Canvas, editor: Editor): void {
  // ---- 描く（敷地の上、設備より下） ----
  const layer = svg('g', { class: 'zones' })
  const site = canvas.world.querySelector('.site')
  if (site) site.after(layer)
  else canvas.world.prepend(layer)

  // ---- 左の欄 ----
  const h = document.createElement('h2')
  h.textContent = '置けない所'
  const box = document.createElement('div')
  box.className = 'zone-panel'
  const info = document.createElement('div')
  info.className = 'info'
  const row = document.createElement('div')
  row.className = 'actions'
  const drawBtn = document.createElement('button')
  drawBtn.type = 'button'
  drawBtn.textContent = '四角を描く'
  drawBtn.title = '防火壁・柱・キュービクルなど、設備も通路も入れない所を、対角の 2 点のクリックで描く'
  drawBtn.addEventListener('click', () => startDraw())
  row.append(drawBtn)

  // 寸法で置く: 左上 x, y と幅・奥行
  const form = document.createElement('form')
  form.className = 'zone-form'
  form.noValidate = true
  const num = (value: number, title: string) => {
    const input = document.createElement('input')
    input.type = 'number'
    input.step = '100'
    input.value = String(value)
    input.title = title
    return input
  }
  const fx = num(0, '左上の x（mm）')
  const fy = num(0, '左上の y（mm）')
  const fw = num(1000, '幅（x 方向、mm）')
  const fh = num(1000, '奥行（y 方向、mm）')
  const addBtn = document.createElement('button')
  addBtn.type = 'submit'
  addBtn.textContent = '置く'
  addBtn.title = 'この左上と寸法の長方形を、置けない所にする'
  const r1 = document.createElement('div')
  r1.className = 'zone-row'
  r1.append('左上', fx, ',', fy)
  const r2 = document.createElement('div')
  r2.className = 'zone-row'
  r2.append('寸法', fw, '×', fh, addBtn)
  form.append(r1, r2)

  const list = document.createElement('div')
  list.className = 'zone-list'
  const hint = document.createElement('div')
  hint.className = 'hint'
  box.append(info, row, form, list, hint)

  // 敷地の欄のすぐ下に置く
  const siteBox = canvas.side.querySelector('.site-panel')
  if (siteBox) siteBox.after(h, box)
  else canvas.side.append(h, box)

  const add = (zone: Zone) => {
    if (editor.run({ type: 'addZone', zone })) hint.textContent = `${zone.name} を置きました。欄で名前・位置・大きさを直せます`
  }
  form.addEventListener('submit', (e) => {
    e.preventDefault()
    const [x, y, w, d] = [fx, fy, fw, fh].map((i) => Number(i.value)) as [number, number, number, number]
    if (![x, y, w, d].every(Number.isFinite) || !(w > 0 && d > 0)) {
      hint.textContent = '位置は数、幅と奥行は正の数（mm）にしてください'
      return
    }
    const s = editor.scene()
    add({ id: nextZoneId(s), name: nextZoneName(s), x, y, width: w, height: d })
  })

  // ---- 2 点で描く道具 ----
  let first: Point | null = null
  const scale = () => canvas.getViewport().scale
  const snapPoint = (p: Point): Point => {
    const step = editor.snapStep()
    return { x: snapValue(p.x, step), y: snapValue(p.y, step) }
  }
  const drawTool: Tool = {
    pointerDown(at) {
      const p = snapPoint(at)
      if (!first) {
        first = p
        hint.textContent = '対角の 2 点目をクリック。Esc でやめる'
        return
      }
      if (p.x === first.x || p.y === first.y) {
        hint.textContent = '幅か奥行が 0 です。斜め向かいの角をクリックしてください'
        return
      }
      const s = editor.scene()
      const zone = zoneFromCorners(nextZoneId(s), nextZoneName(s), first, p)
      first = null
      editor.endTool(drawTool)
      add(zone)
    },
    overlay(pointer) {
      const out: SVGElement[] = []
      const r = MARK_PX / scale()
      const p = pointer ? snapPoint(pointer) : null
      if (first && p) {
        const z = zoneFromCorners('', '', first, p)
        out.push(svg('rect', { class: 'zone drawing', x: z.x, y: z.y, width: z.width, height: z.height }))
      }
      const mark = first ?? p
      if (mark) out.push(svg('path', { class: 'pick-mark', d: `M${mark.x - r} ${mark.y}H${mark.x + r}M${mark.x} ${mark.y - r}V${mark.y + r}` }))
      return out
    },
    ended() {
      first = null
      drawBtn.classList.remove('active')
      if (hint.textContent?.includes('クリック')) hint.textContent = ''
    },
  }
  const startDraw = () => {
    editor.startTool(drawTool)
    drawBtn.classList.add('active')
    first = null
    hint.textContent = '1 つ目の角をクリック（スナップの間隔に乗る）。Esc でやめる'
  }

  // ---- 一覧: 名前・左上・寸法を直す、消す ----
  let listed: readonly Zone[] | undefined
  const renderList = (zones: readonly Zone[]) => {
    if (zones === listed) return
    // 入れている途中（欄の入力にフォーカス）は作り直さない。「消す」のボタンにフォーカスがあるときは作り直す
    const active = document.activeElement
    if (active instanceof HTMLInputElement && list.contains(active)) return
    listed = zones
    list.replaceChildren(
      ...zones.map((z) => {
        const item = document.createElement('div')
        item.className = 'zone-item'
        const name = document.createElement('input')
        name.type = 'text'
        name.value = z.name
        name.title = '名前'
        const del = document.createElement('button')
        del.type = 'button'
        del.textContent = '消す'
        del.title = `${z.name} を消す（元に戻すで戻せる）`
        del.addEventListener('click', () => editor.run({ type: 'removeZone', ids: [z.id] }))
        const head = document.createElement('div')
        head.className = 'zone-row'
        head.append(name, del)
        const x = num(z.x, '左上の x（mm）')
        const y = num(z.y, '左上の y（mm）')
        const w = num(z.width, '幅（mm）')
        const d = num(z.height, '奥行（mm）')
        const pos = document.createElement('div')
        pos.className = 'zone-row'
        pos.append('左上', x, ',', y)
        const size = document.createElement('div')
        size.className = 'zone-row'
        size.append('寸法', w, '×', d)
        const commit = (changes: Partial<Record<'name' | 'x' | 'y' | 'width' | 'height', string | number>>) => {
          const cur = editor.scene().zones.find((q) => q.id === z.id)
          if (!cur) return
          const diff = Object.fromEntries(Object.entries(changes).filter(([k, v]) => cur[k as keyof Zone] !== v))
          if (Object.keys(diff).length && editor.run({ type: 'updateZone', ids: [z.id], changes: diff })) hint.textContent = ''
          // 断られたとき（幅 0 など）も、今の値で欄を作り直す
          listed = undefined
          queueMicrotask(() => renderList(editor.scene().zones))
        }
        name.addEventListener('change', () => commit({ name: name.value }))
        x.addEventListener('change', () => commit({ x: Number(x.value) }))
        y.addEventListener('change', () => commit({ y: Number(y.value) }))
        w.addEventListener('change', () => commit({ width: Number(w.value) }))
        d.addEventListener('change', () => commit({ height: Number(d.value) }))
        item.append(head, pos, size)
        return item
      }),
    )
  }

  // ---- シーンに合わせて描き直す ----
  let drawn: readonly Zone[] | undefined
  function paint() {
    const zones = editor.scene().zones
    if (zones !== drawn) {
      drawn = zones
      layer.replaceChildren(
        ...zones.flatMap((z) => {
          const g = svg('g', { class: 'zone-shape' })
          const rect = svg('rect', { class: 'zone', x: z.x, y: z.y, width: z.width, height: z.height })
          const title = svg('title')
          title.textContent = z.name
          rect.append(title)
          g.append(rect)
          // 名前は設備の名前と同じく図面の mm で、長方形に収まる大きさで描く（倍率に左右されない）。細い壁には書かない
          const font = Math.min(300, z.height * 0.5, z.width / Math.max(z.name.length, 1) / 1.1)
          if (font >= LABEL_MIN_MM) {
            const t = svg('text', { class: 'zone-label', x: z.x + z.width / 2, y: z.y + z.height / 2, 'font-size': font })
            t.textContent = z.name
            g.append(t)
          }
          return [g]
        }),
      )
    }
    info.textContent = zones.length ? `${zones.length} か所` : 'なし'
    renderList(zones)
  }
  editor.onRender(paint)
  paint()
}
