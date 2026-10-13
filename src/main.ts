import './ui/style.css'
import { mountAi } from './ui/ai'
import { mountAisles } from './ui/aisle'
import { mountBackground } from './ui/background'
import { mountCanvas } from './ui/canvas'
import { mountCompare } from './ui/compare'
import { mountEditor } from './ui/editor'
import { mountFlow } from './ui/flow'
import { mountLive } from './ui/live'
import { mountPlans } from './ui/plans'
import { mountPlayback } from './ui/playback'
import { mountSite } from './ui/site'
import { mountStorage } from './ui/storage'
import { mountExportImage } from './ui/exportImage'
import { applySavedTheme, mountMonochrome, mountTheme } from './ui/theme'
import { mountTouch } from './ui/touch'

applySavedTheme()
const app = document.getElementById('app')
if (app) {
  const canvas = mountCanvas(app)
  const editor = mountEditor(canvas)
  mountBackground(canvas, editor)
  mountSite(canvas, editor)
  // つなぎは通路より上に描くので、矢印のクリックを通路より先に受ける
  mountFlow(canvas, editor)
  mountAisles(canvas, editor)
  mountPlayback(canvas, editor)
  const plans = mountPlans(canvas, editor)
  mountStorage(canvas, editor, plans)
  mountCompare(canvas, editor, plans)
  mountAi(canvas, editor)
  mountLive(canvas, editor, plans)
  // 道具バーの先頭に「パネル」を置くので、道具バーに足す部品の後に組む
  mountTouch(canvas, editor)
  mountTheme(canvas)
  mountMonochrome(canvas)
  mountExportImage(canvas, editor, plans)
}
