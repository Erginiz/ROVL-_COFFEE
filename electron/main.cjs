const { app, BrowserWindow, Menu, dialog, Tray, nativeImage } = require('electron')
const path = require('path')
const { classifyUpdateError } = require('../server/update-error.cjs')

// ── Uygulama içi güncelleme ──────────────────────────────────────────────────
// The café PC is somewhere else, so a fix that needs someone to walk over with a 109 MB
// installer is a fix that never arrives. The app checks GitHub Releases on its own and
// downloads in the background — but it does NOT install on its own: that would cut the music
// at whatever moment the download happened to finish. The operator gets a button and picks
// the moment. See docs/guncelleme.md.
//
// State lives here and is handed to the HTTP server below. No IPC or preload is needed
// because startServer() runs inside THIS process — the admin panel reads it over the same
// API as everything else.
const updateState = {
  supported: true,
  version: app.getVersion(),
  checking: false,
  available: false,
  downloading: false,
  percent: 0,
  downloaded: false,
  newVersion: null,
  error: null,
  // Set when the check failed only because nothing has been released yet. Kept apart from
  //  so the panel stays calm while the fact remains visible to anyone looking.
  noReleaseYet: false,
  checkedAt: null
}
let autoUpdater = null
function recordUpdateError(error) {
  updateState.checking = false
  updateState.downloading = false
  Object.assign(updateState, classifyUpdateError(error))
  updateState.checkedAt = new Date().toISOString()
}
function setupUpdater() {
  try {
    ({ autoUpdater } = require('electron-updater'))
  } catch (error) {
    // Running from source, or the dependency is missing: the panel simply says updates are
    // unavailable here rather than breaking.
    updateState.supported = false
    updateState.error = 'Güncelleme bileşeni yüklenemedi'
    return
  }
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = false   // the operator decides when the music stops
  autoUpdater.on('checking-for-update', () => { updateState.checking = true; updateState.error = null; updateState.noReleaseYet = false })
  autoUpdater.on('update-available', info => {
    updateState.checking = false
    updateState.available = true
    updateState.noReleaseYet = false
    updateState.error = null
    updateState.downloading = true
    updateState.newVersion = info?.version || null
  })
  autoUpdater.on('update-not-available', () => {
    updateState.checking = false
    updateState.available = false
    updateState.downloading = false
    updateState.noReleaseYet = false
    updateState.error = null
    updateState.checkedAt = new Date().toISOString()
  })
  autoUpdater.on('download-progress', progress => {
    updateState.downloading = true
    updateState.percent = Math.round(progress?.percent || 0)
  })
  autoUpdater.on('update-downloaded', info => {
    updateState.downloading = false
    updateState.noReleaseYet = false
    updateState.downloaded = true
    updateState.percent = 100
    updateState.newVersion = info?.version || updateState.newVersion
    updateState.checkedAt = new Date().toISOString()
  })
  autoUpdater.on('error', error => {
    // No internet, GitHub unreachable, a malformed release: worth showing, never worth
    // crashing the station over.
    recordUpdateError(error)
  })
  const check = () => {
    try {
      // electron-updater returns a Promise. Catching only synchronous throws left rejected
      // checks as unhandled rejections and made a network outage destabilise the desktop app.
      Promise.resolve(autoUpdater.checkForUpdates()).catch(recordUpdateError)
    } catch (error) { recordUpdateError(error) }
  }
  setTimeout(check, 20000)                     // let the station finish booting first
  setInterval(check, 6 * 3600 * 1000).unref?.()
}
// Handed to the server so the panel can drive it.
const updater = {
  status: () => ({ ...updateState, version: app.getVersion() }),
  check: () => {
    try { Promise.resolve(autoUpdater?.checkForUpdates()).catch(recordUpdateError) }
    catch (error) { recordUpdateError(error) }
  },
  install: () => {
    if (!updateState.downloaded) return false
    // isSilent=false so the operator sees the installer; isForceRunAfter=true so the station
    // comes back up on its own and the café is not left silent waiting for someone to notice.
    setImmediate(() => { try { autoUpdater.quitAndInstall(false, true) } catch {} })
    return true
  }
}

// No default File/Edit/View menu bar — this is a kiosk-style app.
Menu.setApplicationMenu(null)

let server
let mainWindow = null
let tray = null
let shutdownStarted = false
let allowWindowClose = false

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function createTray() {
  if (tray || !Tray) return
  const candidates = [
    path.join(process.resourcesPath || '', 'build', 'icon.ico'),
    path.join(__dirname, '..', 'build', 'icon.ico')
  ]
  let icon = nativeImage?.createEmpty?.()
  for (const candidate of candidates) {
    try {
      if (require('fs').existsSync(candidate)) { icon = nativeImage.createFromPath(candidate); break }
    } catch {}
  }
  try {
    tray = new Tray(icon)
    tray.setToolTip('Rovli Radyo')
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Paneli Aç', click: showMainWindow },
      { type: 'separator' },
      { label: 'Yayını Durdur ve Çık', click: () => { allowWindowClose = true; app.quit() } }
    ]))
    tray.on('click', showMainWindow)
    tray.on('double-click', showMainWindow)
  } catch (error) { console.error('Bildirim alanı hazırlanamadı:', error.message) }
}

// Only one instance may run — a second launch would fight over ports 8090/8443.
// If someone re-opens the app, just focus the existing window instead.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus() }
  })

  const createWindow = () => {
    if (mainWindow && !mainWindow.isDestroyed()) { showMainWindow(); return mainWindow }
    const window = new BrowserWindow({
      width: 1360,
      height: 900,
      minWidth: 1080,
      minHeight: 720,
      backgroundColor: '#F9F7F2',
      title: 'Rovli Radio',
      autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false }
    })
    mainWindow = window
    createTray()
    window.on('close', event => {
      if (allowWindowClose || shutdownStarted || !tray) return
      // The X button hides the operator panel but leaves the radio and its listeners alive.
      // The tray menu is the explicit stop action.
      event.preventDefault()
      window.hide()
    })
    window.on('closed', () => { if (mainWindow === window) mainWindow = null })
    // Not a literal 8090: the station binds whatever PORT says, and the error dialog below
    // already reads it. Hardcoding it here meant that with PORT set, the panel opened on an
    // address nothing was serving — a blank window with no explanation.
    const address = process.env.CAFE_RADIO_DEV === '1'
      ? 'http://127.0.0.1:5173/admin'
      : `http://127.0.0.1:${process.env.PORT || 8090}/admin`
    window.loadURL(address).catch(error => {
      console.error('Yönetim paneli açılamadı:', error.message)
      try { dialog.showErrorBox('Rovli Radyo paneli açılamadı', error.message) } catch {}
    })
    return window
  }

  app.whenReady().then(() => {
    if (process.env.CAFE_RADIO_DEV === '1') {
      createWindow()
    } else {
      process.env.CAFE_RADIO_DATA = path.join(app.getPath('userData'), 'data')
      const { startServer } = require('../server/index.cjs')
      setupUpdater()
      server = startServer({ updater })
      server.once('listening', createWindow)
      // A station that could not take its port serves nothing: the panel would open onto a
      // page that never loads, and the phones would get "connection refused" with the café
      // left guessing. The panel itself cannot report this — it is served BY the thing that
      // failed — so say it in the only place left, a dialog.
      server.once('startup-failed', error => {
        const message = error?.code === 'EADDRINUSE'
          ? `Rovli Radyo zaten çalışıyor olabilir.\n\nPort ${process.env.PORT || 8090} başka bir program tarafından kullanılıyor. ` +
            'Görev Yöneticisi\'nde açık bir "Rovli Radyo" varsa kapatıp yeniden başlatın.'
          : `Rovli Radyo başlatılamadı.\n\n${error?.message || error}`
        try { dialog.showErrorBox('Rovli Radyo başlatılamadı', message) } catch {}
        allowWindowClose = true
        app.quit()
      })
    }
    app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow())
  })

  app.on('window-all-closed', () => {
    if (tray && !allowWindowClose && !shutdownStarted) return
    if (process.platform !== 'darwin') app.quit()
  })

  // Closing the app must actually close the STATION: flush the state to disk, stop the
  // timers, end every listener's connection and kill ffmpeg. `server.close()` alone did
  // none of that — it only stops accepting new connections, and the long-lived audio and
  // event streams never end on their own, so it could not even finish. Everything else was
  // left to the process-exit hook, which is a backstop, not a plan.
  app.on('before-quit', event => {
    if (shutdownStarted || !server?.gracefulShutdown) { try { server?.close() } catch {} ; return }
    // Hold the quit open just long enough to shut down cleanly, then quit for real. The
    // timeout is the safety net: a station that refuses to close is worse than an untidy one.
    event.preventDefault()
    shutdownStarted = true
    let done = false
    const finish = () => { if (!done) { done = true; try { tray?.destroy() } catch {}; tray = null; app.quit() } }
    setTimeout(finish, 5000).unref?.()
    try { server.gracefulShutdown() } catch {}
    // gracefulShutdown flushes state synchronously and asks child processes to exit. Give
    // those pipes a short turn before quitting; the five-second timer above is the backstop.
    setTimeout(finish, 100).unref?.()
  })
}
