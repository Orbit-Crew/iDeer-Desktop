// Adapted from the pinned linz src/main/window.ts. See docs/porting.md.
import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { BROWSER_PARTITION, isWebUrl } from '../shared/desktop'

export function createMainWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    frame: true,
    title: 'iDeer Desktop',
    titleBarStyle: 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Issue 107: the restored browser pane is the one external-content
      // surface, so the main window may embed webviews again. Attachment is
      // validated below, never blanket-allowed.
      webviewTag: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow.show())
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())
  // Issue 107: a webview may attach only with the fixed browser partition,
  // no node integration, no preload of any kind, no popups, and the
  // sandbox/isolation pair intact — a page inside the pane cannot reach the
  // trusted bridge through a smuggled preload or a relaxed guest, and no
  // other partition (the app's own default session included) can be
  // embedded. The first document must already be a web document; the
  // session-level gates in browserPane.ts keep enforcing this after
  // attachment.
  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    // `allowpopups` rides the runtime preferences but predates the typings.
    const attachPreferences = webPreferences as typeof webPreferences & { allowpopups?: boolean }
    if (webPreferences.nodeIntegration ||
        webPreferences.preload ||
        attachPreferences.allowpopups === true ||
        webPreferences.contextIsolation === false ||
        webPreferences.sandbox === false ||
        params.partition !== BROWSER_PARTITION ||
        (typeof params.src === 'string' && params.src !== '' && !isWebUrl(params.src))) {
      event.preventDefault()
    }
  })
  mainWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  mainWindow.webContents.session.setPermissionCheckHandler(() => false)

  const devURL = !app.isPackaged && process.env['ELECTRON_RENDERER_URL']
  if (devURL) {
    void mainWindow.loadURL(devURL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return mainWindow
}
