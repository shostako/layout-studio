import './ui/style.css'
import { mountCanvas } from './ui/canvas'
import { mountEditor } from './ui/editor'

const app = document.getElementById('app')
if (app) mountEditor(mountCanvas(app))
