// 工程のつなぎ: 設備から設備へ矢印を引く（「つなぐ」で 1 本ずつ、「工程の順につなぐ」で選んだ設備をまとめて）、選ぶ、外す。
// シーンの変更は editor.run（コマンド）を通す。つなぐ途中の元の設備と、つなぎの選択は画面の状態で、シーンには入れない。
import type { Canvas } from './canvas'
import type { Editor, Tool } from './editor'
import { chainByProcess, linkHitTest, linkSegment, neighbors, sameLink, type Link } from '../core/flow'
import { hitTest } from '../core/placement'
import { footprint, type Scene } from '../core/scene'
import type { Point } from '../core/viewport'

const SVG_NS = 'http://www.w3.org/2000/svg'
// 矢印から何 px 以内のクリックで選ぶか
const HIT_PX = 5
// 矢じりの長さと幅の半分（mm）。設備と同じく図面の大きさで描く（短い矢印では線の長さの半分まで縮める）
const HEAD_MM = 400
const HEAD_HALF_MM = 160

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v))
  return el
}

// p → q の矢印（線と、q の側の矢じり）
function arrow(p: Point, q: Point, cls: string): SVGGElement {
  const g = svg('g', { class: cls })
  const len = Math.hypot(q.x - p.x, q.y - p.y)
  const head = Math.min(HEAD_MM, len * 0.5)
  const ux = len ? (q.x - p.x) / len : 1
  const uy = len ? (q.y - p.y) / len : 0
  const bx = q.x - ux * head
  const by = q.y - uy * head
  const w = HEAD_HALF_MM * (head / HEAD_MM)
  g.append(
    svg('path', { class: 'link-line', d: `M${p.x} ${p.y}L${bx} ${by}` }),
    svg('polygon', { class: 'link-head', points: `${q.x},${q.y} ${bx - uy * w},${by + ux * w} ${bx + uy * w},${by - ux * w}` }),
  )
  return g
}

export function mountFlow(canvas: Canvas, editor: Editor): void {
  // 設備より上に描く（設備の外形の縁から縁へ引くので、設備には重ならない）
  const layer = svg('g', { class: 'link-layer' })
  canvas.world.querySelector('.equipment-layer')!.after(layer)
  let selected: Link | null = null
  const scale = () => canvas.getViewport().scale
  const name = (s: Scene, id: string) => s.equipment.find((e) => e.id === id)?.name ?? id

  // ---- 左の欄 ----
  const h = document.createElement('h2')
  h.textContent = '工程のつなぎ'
  const info = document.createElement('div')
  info.className = 'info'
  const actions = document.createElement('div')
  actions.className = 'actions link-actions'
  const mkButton = (label: string, title: string, onClick: () => void) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = label
    b.title = title
    b.addEventListener('click', onClick)
    actions.append(b)
    return b
  }
  const linkBtn = mkButton('つなぐ', '元の設備、次の設備の順にクリックして矢印を引く。続けてクリックすると次へつながる。Esc でやめる', () => startLinking())
  const chainBtn = mkButton('工程の順につなぐ', '選んだ設備を、成形機 → 取出機 → 型抜き機 → トリミング機 → 重量計 → 台車ストッカーの順につなぐ', () => chainSelection())
  const unlinkBtn = mkButton('つなぎを外す', '選んだつなぎを外す（Delete。元に戻すで戻せる）', () => removeSelection())
  const hint = document.createElement('div')
  hint.className = 'hint'

  // 重なりの一覧の下に置く
  const after = canvas.side.querySelector('.overlap-list')
  if (after) after.after(h, info, actions, hint)
  else canvas.side.append(h, info, actions, hint)

  const select = (l: Link | null) => {
    if (l) editor.claimSelection('flow')
    selected = l
    editor.render()
  }
  editor.onClaim((owner) => {
    if (owner !== 'flow') selected = null
  })
  editor.onReset(() => (selected = null))

  const removeSelection = () => {
    if (selected && editor.run({ type: 'unlink', links: [selected] })) select(null)
  }
  const chainSelection = () => {
    const r = chainByProcess(editor.scene(), editor.selection())
    if (!r.ok) {
      hint.textContent = r.error
      return
    }
    if (editor.run({ type: 'link', links: r.links })) hint.textContent = `${r.links.length} 本つなぎました`
  }

  // ---- つなぐ道具: 元の設備、次の設備の順にクリック ----
  let from: string | null = null
  const linking = () => linkBtn.classList.contains('active')
  const linkTool: Tool = {
    pointerDown(at) {
      const scene = editor.scene()
      const hit = hitTest(scene, at)
      if (!hit || hit === from) {
        // 設備の無い所か、同じ設備をもう一度クリックしたら、元の設備を選び直す
        from = null
      } else if (from === null) {
        from = hit
      } else if (editor.run({ type: 'link', links: [{ from, to: hit }] })) {
        hint.textContent = `${name(editor.scene(), from)} → ${name(editor.scene(), hit)} をつなぎました`
        // 続けてクリックすると、いまの設備から次へつながる
        from = hit
      }
      showProgress()
    },
    overlay(pointer) {
      const scene = editor.scene()
      const src = scene.equipment.find((e) => e.id === from)
      if (!src) return []
      const fp = footprint(src)
      const out: SVGElement[] = [svg('rect', { class: 'link-from', x: fp.x, y: fp.y, width: fp.width, height: fp.height })]
      if (pointer) {
        const target = scene.equipment.find((e) => e.id === hitTest(scene, pointer))
        const [p, q] = target && target !== src ? linkSegment(src, target) : [{ x: src.x, y: src.y }, pointer]
        out.push(arrow(p, q, 'link drawing'))
      }
      return out
    },
    ended() {
      from = null
      linkBtn.classList.remove('active')
      if (hint.textContent?.startsWith('元の') || hint.textContent?.startsWith('次の')) hint.textContent = ''
    },
  }
  const showProgress = () => {
    if (!linking()) return
    if (from === null) hint.textContent = '元の設備をクリック。Esc でやめる'
    else if (!hint.textContent?.endsWith('つなぎました')) hint.textContent = `次の設備をクリック（元: ${name(editor.scene(), from)}）。Esc でやめる`
  }
  const startLinking = () => {
    // 1 台を選んでいれば、それを元の設備にして始める
    const sel = editor.selection()
    editor.startTool(linkTool)
    linkBtn.classList.add('active')
    linkBtn.blur()
    selected = null
    from = sel.length === 1 ? sel[0]! : null
    hint.textContent = ''
    showProgress()
    editor.render()
  }

  // ---- 選ぶ: 矢印の近くのクリック（設備が上にあれば設備を先に当てる） ----
  editor.onGrab((at, e) => {
    const scene = editor.scene()
    if (e.shiftKey || hitTest(scene, at)) return null
    const hit = linkHitTest(scene, at, HIT_PX / scale())
    if (!hit) return null
    select(hit)
    // つなぎはドラッグで動かさない（設備を動かせば付いてくる）
    return { move: () => null }
  })
  editor.onEmptyClick(() => {
    selected = null
  })

  // ---- キー ----
  const isInteractive = (t: EventTarget | null) =>
    t instanceof HTMLElement && (t.isContentEditable || t.closest('input, select, textarea') !== null)
  window.addEventListener('keydown', (e) => {
    if (!selected || isInteractive(e.target) || e.ctrlKey || e.metaKey || e.altKey) return
    if (e.key === 'Delete' || e.key === 'Backspace') removeSelection()
    else if (e.key === 'Escape') select(null)
    else return
    e.preventDefault()
  })

  // ---- シーンに合わせて描き直す ----
  function paint() {
    const scene = editor.scene()
    // 設備を選んだらつなぎの選択は外す
    if (editor.selection().length > 0) selected = null
    if (selected && !scene.links.some((l) => sameLink(l, selected!))) selected = null
    // ドラッグ中は動かした先を描く
    const shown = editor.shown()
    layer.replaceChildren(
      ...shown.links.flatMap((l) => {
        const a = shown.equipment.find((e) => e.id === l.from)
        const b = shown.equipment.find((e) => e.id === l.to)
        if (!a || !b) return []
        const [p, q] = linkSegment(a, b)
        return [arrow(p, q, `link${selected && sameLink(l, selected) ? ' selected' : ''}`)]
      }),
    )

    const sel = editor.selection()
    info.textContent = scene.links.length ? `${scene.links.length} 本` : 'なし'
    if (selected) {
      info.textContent += `　選択中: ${name(scene, selected.from)} → ${name(scene, selected.to)}（Delete で外す）`
    } else if (sel.length === 1) {
      const n = neighbors(scene, sel[0]!)
      const list = (ids: string[]) => (ids.length ? ids.map((id) => name(scene, id)).join('、') : 'なし')
      info.textContent += `　${name(scene, sel[0]!)}の前: ${list(n.prev)}、次: ${list(n.next)}`
    }
    chainBtn.disabled = sel.length < 2
    unlinkBtn.disabled = !selected
    // 選択が変わったら、前の結果の知らせは消す
    if (!linking() && hint.textContent && !selected && sel.length < 2) hint.textContent = ''
  }
  editor.onRender(paint)
  paint()
}
