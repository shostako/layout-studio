// PDF の 1 ページを画像（JPEG の data URL）にする。pdf.js は大きいので、PDF を読むときにだけ取りに行く。
import { pdfRenderScale } from '../core/background'

export type PdfPage = { src: string; width: number; height: number; dpi: number; page: number; pages: number }

// ページの番号は 1 から。ページの回転（スキャナーが付けた向き）はそのまま当てる
export async function renderPdfPage(data: ArrayBuffer, page = 1): Promise<PdfPage> {
  const pdfjs = await import('pdfjs-dist')
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default
  // pdf.js は渡した配列を手放させるので、写しを渡す（同じ PDF の別のページをまた読めるように）
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data.slice(0)) }).promise
  try {
    const pages = doc.numPages
    if (!(page >= 1 && page <= pages)) throw new Error(`ページは 1〜${pages} です`)
    const p = await doc.getPage(page)
    const base = p.getViewport({ scale: 1 })
    const { scale, dpi } = pdfRenderScale(base.width, base.height)
    const viewport = p.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = Math.floor(viewport.width)
    canvas.height = Math.floor(viewport.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('この表示先では PDF を画像にできません')
    // 透明な所を白に（JPEG にすると黒くなるため）
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    await p.render({ canvas, canvasContext: ctx, viewport }).promise
    // 図面はスキャンの写真のようなものが多いので JPEG で軽くする
    const src = canvas.toDataURL('image/jpeg', 0.85)
    return { src, width: canvas.width, height: canvas.height, dpi, page, pages }
  } finally {
    void doc.destroy()
  }
}
