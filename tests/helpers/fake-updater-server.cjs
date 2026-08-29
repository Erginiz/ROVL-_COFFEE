// Boots the real server with a FAKE updater in place of electron-updater, so the update API
// can be exercised without GitHub, without Electron, and without actually restarting anything.
//
// The fake is driven over a tiny control port: a test says "pretend a download finished" and
// the station's own endpoints have to react exactly as they would in the café.
//
// Run as: node fake-updater-server.cjs   (env: PORT, CAFE_RADIO_DATA, CONTROL_PORT, SCENARIO)
const http = require('http')
const path = require('path')

const scenario = process.env.SCENARIO || 'idle'
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

// Records what the station asked the updater to do, so a test can assert that pressing the
// button really reached quitAndInstall rather than merely returning 200.
const calls = { check: 0, install: 0 }
const updater = {
  status: () => ({ ...state }),
  check: () => { calls.check++; state.checking = true },
  install: () => {
    calls.install++
    if (!state.downloaded) return false
    return true   // the real one calls quitAndInstall; here we just record it
  }
}

const { startServer } = require(path.join(__dirname, '..', '..', 'server', 'index.cjs'))
startServer({ updater })

// Control surface for the test: read what happened, or push the fake forward.
http.createServer((req, res) => {
  if (req.url === '/calls') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(calls)); return }
  if (req.url === '/finish-download') {
    state.downloading = false; state.downloaded = true; state.percent = 100; state.newVersion = '0.3.3'
    res.writeHead(200); res.end('ok'); return
  }
  res.writeHead(404); res.end()
}).listen(Number(process.env.CONTROL_PORT), '127.0.0.1')
