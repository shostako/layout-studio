import './ui/style.css'
import { mountBackground } from './ui/background'
import { mountCanvas } from './ui/canvas'
import { mountEditor } from './ui/editor'

const app = document.getElementById('app')
if (app) {
  const canvas = mountCanvas(app)
  mountBackground(canvas, mountEditor(canvas))
}
