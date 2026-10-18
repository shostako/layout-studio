import './ui/style.css'
import { mountAi } from './ui/ai'
import { mountAttach } from './ui/attach'
import { mountBlock } from './ui/block'
import { mountAisles } from './ui/aisle'
import { mountBackground } from './ui/background'
import { mountCanvas } from './ui/canvas'
import { mountCompare } from './ui/compare'
import { mountEditor } from './ui/editor'
import { mountFlow } from './ui/flow'
import { mountGrid } from './ui/grid'
import { mountLive } from './ui/live'
import { mountPlans } from './ui/plans'
import { mountPlayback } from './ui/playback'
import { mountSite } from './ui/site'
import { mountZones } from './ui/zone'
import { mountStorage } from './ui/storage'
import { sceneExtent } from './core/site'
import { mountExportImage } from './ui/exportImage'
import { applySavedTheme, mountMonochrome, mountTheme } from './ui/theme'
import { mountTemplates } from './ui/templates'
import { mountTouch } from './ui/touch'

applySavedTheme()
const app = document.getElementById('app')
if (app) {
  const canvas = mountCanvas(app)
  const editor = mountEditor(canvas)
  // 「全体」（0 キー）はその時のシーンの背景・敷地・設備・通路を囲む範囲に合わせる
  canvas.setHomeSource(() => sceneExtent(editor.scene()))
  const grid = mountGrid(canvas, editor)
  mountTemplates(canvas, editor)
  mountBlock(canvas, editor)
  mountAttach(canvas, editor)
  mountBackground(canvas, editor)
  mountSite(canvas, editor)
  mountZones(canvas, editor)
  // つなぎは通路より上に描くので、矢印のクリックを通路より先に受ける
  mountFlow(canvas, editor)
  mountAisles(canvas, editor)
  mountPlayback(canvas, editor)
  const plans = mountPlans(canvas, editor)
  const storage = mountStorage(canvas, editor, plans)
  // 「初期設定」で開き直す前に、待っている自動保存を書き終える
  grid.setBeforeReload(storage.flush)
  mountCompare(canvas, editor, plans)
  mountAi(canvas, editor)
  mountLive(canvas, editor, plans)
  // 道具バーの先頭に「パネル」を置くので、道具バーに足す部品の後に組む
  mountTouch(canvas, editor)
  mountTheme(canvas)
  mountMonochrome(canvas)
  mountExportImage(canvas, editor, plans)
}
