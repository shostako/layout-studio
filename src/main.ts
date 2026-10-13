import './ui/style.css'
import { mountBackground } from './ui/background'
import { mountCanvas } from './ui/canvas'
import { mountEditor } from './ui/editor'
import { mountStorage } from './ui/storage'

const app = document.getElementById('app')
if (app) {
  const canvas = mountCanvas(app)
  const editor = mountEditor(canvas)
  mountBackground(canvas, editor)
  mountStorage(canvas, editor)
}
