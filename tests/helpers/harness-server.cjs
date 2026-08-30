// Boots the REAL server with test hooks attached, over a side channel the tests drive.
//
// Two things need this. The updater cannot be exercised through Electron in a test, so a
// fake stands in for it. And graceful shutdown must be triggered the way the desktop app
// triggers it — through the handle the server exposes — WITHOUT adding a shutdown endpoint
// to the product, which would be an obvious thing to abuse from the café Wi-Fi.
//
// Run as: node harness-server.cjs   (env: PORT, CAFE_RADIO_DATA, CONTROL_PORT, SCENARIO)
const http = require('http')
const path = require('path')

const scenario = process.env.SCENARIO || 'none'
const state = {
  supported: true,
  version: '0.3.2',
  checking: false,
  available: false,
  downloading: false,
  percent: 0,
  downloaded: scenario === 'downloaded',
  newVersion: scenario === 'downloaded' ? '0.3.3' : null,
  error: null,
  checkedAt: null
}
if (scenario === 'downloading') { state.available = true; state.downloading = true; state.percent = 42; state.newVersion = '0.3.3' }
if (scenario === 'error') { state.error = 'Ağ hatası: GitHub erişilemedi' }

// Records what the station asked the updater to do, so a test can assert the button really
// reached quitAndInstall rather than merely returning 200.
const calls = { check: 0, install: 0 }
const updater = {
  status: () => ({ ...state }),
  check: () => { calls.check++; state.checking = true },
  install: () => { calls.install++; return state.downloaded }
}

const { startServer } = require(path.join(__dirname, '..', '..', 'server', 'index.cjs'))
// Only hand the updater over when a scenario asked for one: a plain run must look exactly
// like the product does when it is started from source, with no updater at all.
const server = startServer(scenario === 'none' ? {} : { updater })

http.createServer((req, res) => {
  if (req.url === '/calls') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(calls)); return }
  if (req.url === '/finish-download') {
    state.downloading = false; state.downloaded = true; state.percent = 100; state.newVersion = '0.3.3'
    res.writeHead(200); res.end('ok'); return
  }
  if (req.url === '/shutdown') {
    // Exactly what electron/main.cjs does on before-quit.
    try { server.gracefulShutdown() } catch (error) { res.writeHead(500); res.end(String(error?.message)); return }
    res.writeHead(200); res.end('ok')
    return
  }
  res.writeHead(404); res.end()
}).listen(Number(process.env.CONTROL_PORT), '127.0.0.1')
