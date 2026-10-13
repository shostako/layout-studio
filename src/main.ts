import './ui/style.css'
import { mountAisles } from './ui/aisle'
import { mountBackground } from './ui/background'
import { mountCanvas } from './ui/canvas'
import { mountEditor } from './ui/editor'
import { mountSite } from './ui/site'
import { mountStorage } from './ui/storage'

const app = document.getElementById('app')
if (app) {
  const canvas = mountCanvas(app)
  const editor = mountEditor(canvas)
  mountBackground(canvas, editor)
  mountSite(canvas, editor)
  mountAisles(canvas, editor)
  mountStorage(canvas, editor)
}
