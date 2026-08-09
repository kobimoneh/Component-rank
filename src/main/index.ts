import { app, BrowserWindow, shell, ipcMain, session, dialog } from 'electron'
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootstrap, type BootstrapResult } from './bootstrap.js'
import { registerIpc, registerMutationIpc } from './ipc.js'

const here = dirname(fileURLToPath(import.meta.url))

let boot: BootstrapResult | null = null

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#0e1116',
    title: 'Component Library',
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      // Security posture, per docs/ARCHITECTURE.md: the renderer gets no Node,
      // no filesystem and no database handle — only the named preload API.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload uses ESM imports; contextIsolation still applies
      webviewTag: false,
      spellcheck: false,
    },
  })

  win.once('ready-to-show', () => {
    win.show()
    // Dev/CI capture hook: render the window to a PNG and exit. Used to verify
    // the renderer without a human at the screen.
    const shot = process.env['SCREENSHOT_PATH']
    if (shot) {
      // Named actions only — never arbitrary script from the environment.
      const ACTIONS: Record<string, string> = {
        table: 'true',
        drawer: `(() => {
          const row = document.querySelector('table.grid tbody tr:nth-child(2)')
          row?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
          return true
        })()`,
        parameters: `(() => {
          const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Parameters')
          btn?.click()
          return true
        })()`,
        compare: `(() => {
          const boxes = [...document.querySelectorAll('table.grid tbody input[type=checkbox]')]
          boxes.slice(0, 4).forEach((b) => b.click())
          const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Compare')
          btn?.click()
          return true
        })()`,
      }
      const action = ACTIONS[process.env['SCREENSHOT_ACTION'] ?? 'table'] ?? 'true'
      setTimeout(() => {
        void win.webContents
          .executeJavaScript(action)
          .then(() => new Promise((r) => setTimeout(r, 1200)))
          .then(() => win.webContents.capturePage())
          .then((img) => {
            writeFileSync(shot, img.toPNG())
            app.quit()
          })
      }, 3000)
    }
  })

  // External links open in the real browser; the app never navigates away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    const devServer = process.env['ELECTRON_RENDERER_URL']
    if (devServer && url.startsWith(devServer)) return
    event.preventDefault()
    void shell.openExternal(url)
  })

  const devServer = process.env['ELECTRON_RENDERER_URL']
  if (devServer) {
    void win.loadURL(devServer)
  } else {
    void win.loadFile(join(here, '../renderer/index.html'))
  }

  return win
}

app.whenReady().then(() => {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          process.env['ELECTRON_RENDERER_URL']
            ? "default-src 'self' 'unsafe-inline' data: blob: ws: http://localhost:*"
            : "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
        ],
      },
    })
  })

  try {
    boot = bootstrap(app.getPath('userData'))
    registerIpc(ipcMain, boot)
    registerMutationIpc(ipcMain, boot, {
      async saveFile(defaultName, contents) {
        const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
        const result = win
          ? await dialog.showSaveDialog(win, { defaultPath: defaultName })
          : await dialog.showSaveDialog({ defaultPath: defaultName })
        if (result.canceled || !result.filePath) return { path: null, cancelled: true }
        writeFileSync(result.filePath, contents, 'utf8')
        return { path: result.filePath, cancelled: false }
      },
    })
  } catch (err) {
    // Fail loudly and visibly rather than opening an empty window that looks fine.
    console.error('Startup failed:', err)
    app.exit(1)
    return
  }

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  boot?.db.close()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  boot?.db.close()
  boot = null
})
