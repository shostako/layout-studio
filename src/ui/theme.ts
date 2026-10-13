// 道具バーの「表示」ボタン: 色の見え方を 自動・ライト・ダーク で回す。「白黒」ボタン: 設備などを白黒の線で描く（正式な図面の見え方）。
// どちらも選んだものはこのブラウザに覚えておく（localStorage）。
// 覚えておけないブラウザ（プライベートの窓など）でも、開いている間は効く。
import { THEME_LABEL, nextTheme, parseTheme, themeAttribute, type ThemeChoice } from '../core/theme'
import type { Canvas } from './canvas'

// index.html の先頭の script も同じ鍵を読む（最初の描画より前に当てるため）。変えるときは両方を直す
const KEY = 'layout-studio:theme'

const load = (): ThemeChoice => {
  try {
    return parseTheme(localStorage.getItem(KEY))
  } catch {
    return 'auto'
  }
}
const store = (t: ThemeChoice) => {
  try {
    if (t === 'auto') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, t)
  } catch {
    // 覚えておけなくても、今の画面には効いている
  }
}
const apply = (t: ThemeChoice) => {
  const a = themeAttribute(t)
  if (a) document.documentElement.dataset.theme = a
  else delete document.documentElement.dataset.theme
}

// 画面を組む前に呼ぶ。index.html の先頭で当てているので、ふつうは同じ値を当て直すだけ
export function applySavedTheme(): void {
  apply(load())
}

export function mountTheme(canvas: Canvas): void {
  let theme = load()
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'theme-toggle'
  const show = () => {
    b.textContent = `表示: ${THEME_LABEL[theme]}`
    b.title = `色の見え方（今は${THEME_LABEL[theme]}）。押すと 自動 → ライト → ダーク と切り替わる。自動は OS の設定に従う`
  }
  b.addEventListener('click', () => {
    theme = nextTheme(theme)
    apply(theme)
    store(theme)
    show()
    b.blur()
  })
  show()
  canvas.toolbar.insertBefore(b, canvas.toolbar.querySelector('.help'))
}

const MONO_KEY = 'layout-studio:mono'

export function mountMonochrome(canvas: Canvas): void {
  const root = canvas.svg.closest('.canvas-root')
  if (!(root instanceof HTMLElement)) return
  let on = false
  try {
    on = localStorage.getItem(MONO_KEY) === '1'
  } catch {
    // 覚えておけないブラウザでは色つきから始める
  }
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'mono-toggle'
  b.textContent = '白黒'
  const show = () => {
    root.classList.toggle('mono', on)
    b.classList.toggle('active', on)
    b.setAttribute('aria-pressed', String(on))
    b.title = on ? '白黒で描いている。押すと色つきに戻す' : '設備・通路・敷地を白黒の線で描く（正式な図面の見え方。画像の保存も白黒になる）'
  }
  b.addEventListener('click', () => {
    on = !on
    try {
      if (on) localStorage.setItem(MONO_KEY, '1')
      else localStorage.removeItem(MONO_KEY)
    } catch {
      // 覚えておけなくても、今の画面には効いている
    }
    show()
    b.blur()
  })
  show()
  canvas.toolbar.insertBefore(b, canvas.toolbar.querySelector('.theme-toggle') ?? canvas.toolbar.querySelector('.help'))
}
