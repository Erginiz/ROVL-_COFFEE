// Shared harness for the resilience tests. These run the REAL server with the REAL
// ffmpeg: the bugs this suite exists to catch are process-lifecycle and timing bugs
// (an encoder crash wedging the pump, orphaned children, a decoder that never yields),
// and none of them reproduce against mocks. Each test gets its own temp data dir and
// its own port, so runs are isolated and can't touch the operator's real library.

const { spawn, execFileSync, execSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const https = require('https')

const PROJECT_ROOT = path.join(__dirname, '..', '..')
const SERVER = path.join(PROJECT_ROOT, 'server', 'index.cjs')
const ffmpegPath = require(path.join(PROJECT_ROOT, 'node_modules', 'ffmpeg-static'))
// Generated tone files are identical every run, so build them once and reuse.
const FIXTURE_CACHE = path.join(os.tmpdir(), 'rovli-test-fixtures')

const sleep = ms => new Promise(r => setTimeout(r, ms))

// Poll until `fn()` returns truthy. Timing-based waits make these tests flaky on a busy
// machine; a condition with a deadline does not.
async function waitFor(fn, { timeoutMs = 15000, intervalMs = 250, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let value
    try { value = await fn() } catch { value = false }
    if (value) return value
    if (Date.now() >= deadline) throw new Error(`waitFor timed out after ${timeoutMs}ms: ${label}`)
    await sleep(intervalMs)
  }
}

// A playable MP3 of `seconds` length. Real audio, so the decoder behaves as it does live.
function makeTone(seconds = 6, freq = 440) {
  fs.mkdirSync(FIXTURE_CACHE, { recursive: true })
  const file = path.join(FIXTURE_CACHE, `tone-${freq}-${seconds}.mp3`)
  if (!fs.existsSync(file)) {
    execFileSync(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${seconds}`, '-b:a', '128k', file])
  }
  return file
}

// Bytes that are named .mp3 but are not audio — the "unreadable file" case the engine
// has to skip past instead of freezing the broadcast on.
function writeCorrupt(destFile) {
  fs.writeFileSync(destFile, Buffer.from('not audio at all '.repeat(200)))
}

// ── Windows process inspection ────────────────────────────────────────────────
// Children are matched by PPID, never by command line: matching on the command line
// would also pick up any ffmpeg the developer happens to be running, and a test that
// can kill unrelated processes is worse than no test.
function ffmpegChildrenOf(pid) {
  try {
    const out = execSync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='ffmpeg.exe'\\" | Where-Object { $_.ParentProcessId -eq ${pid} } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"`,
      { encoding: 'utf8', windowsHide: true })
    let arr = JSON.parse(out.trim() || '[]')
    if (!Array.isArray(arr)) arr = [arr]
    return arr.filter(Boolean).map(p => ({ pid: p.ProcessId, cmd: String(p.CommandLine || '') }))
  } catch { return [] }
}
function pidAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}
function killPid(pid) {
  try { process.kill(pid, 'SIGKILL') } catch {}
}

// The persistent MP3 encoder vs. the per-track PCM decoder. Both are ffmpeg; only the
// encoder writes an mp3 stream, which is what tells them apart.
const isEncoder = p => /-f\s+mp3/.test(p.cmd)
const isDecoder = p => !isEncoder(p) && /-f\s+s16le/.test(p.cmd)

// The machine's own LAN address. Auth behaves completely differently depending on where a
// request comes from — 127.0.0.1 is the trusted café PC and bypasses everything — so the
// security tests MUST arrive over the LAN interface to exercise the path a phone takes.
// Returns null on a machine with no LAN (those tests then skip rather than pass vacuously).
function lanIp() {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const item of addresses || []) {
      if (item.family !== 'IPv4' || item.internal) continue
      if (item.address.startsWith('169.254.')) continue
      return item.address
    }
  }
  return null
}

// ── Server under test ─────────────────────────────────────────────────────────
let nextPort = 8300 + Math.floor(Math.random() * 200)

// `dataDir` lets a test reuse a folder it has already seeded — used by the state-migration
// tests, which need to plant an old station.json and then boot against it.
// `env` adds environment variables for the server under test — used to point the prayer-time
// client at a fake API so its retry behaviour can be tested without the network.
// `updaterScenario` boots the server through a harness entry point that injects a FAKE
// updater (see fake-updater-server.cjs), so the in-app update flow can be tested without
// Electron, GitHub, or actually restarting anything.
async function startServer({ music = [makeTone()], ads = [], corruptMusic = 0, dataDir: existingDir = null, env = {}, updaterScenario = null, control = false } = {}) {
  const port = nextPort++
  const dataDir = existingDir || fs.mkdtempSync(path.join(os.tmpdir(), 'rovli-test-'))
  fs.mkdirSync(path.join(dataDir, 'Music'), { recursive: true })
  fs.mkdirSync(path.join(dataDir, 'Ads'), { recursive: true })
  music.forEach((src, i) => fs.copyFileSync(src, path.join(dataDir, 'Music', `track-${i}.mp3`)))
  ads.forEach((src, i) => fs.copyFileSync(src, path.join(dataDir, 'Ads', `ad-${i}.mp3`)))
  for (let i = 0; i < corruptMusic; i++) writeCorrupt(path.join(dataDir, 'Music', `broken-${i}.mp3`))

  // The harness entry point is only used when a test needs a side channel (a fake updater,
  // or triggering graceful shutdown the way the desktop app does). Everything else runs the
  // product's own entry point, unmodified.
  const needsControl = !!updaterScenario || control
  const controlPort = needsControl ? port + 2000 : null
  const entry = needsControl ? path.join(__dirname, 'harness-server.cjs') : SERVER
  const proc = spawn(process.execPath, [entry], {
    env: {
      ...process.env, CAFE_RADIO_DATA: dataDir, PORT: String(port), HTTPS_PORT: String(port + 1000),
      ...(needsControl ? { SCENARIO: updaterScenario || 'none', CONTROL_PORT: String(controlPort) } : {}),
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  })
  let output = ''
  proc.stdout.on('data', d => { output += d })
  proc.stderr.on('data', d => { output += d })

  // `host` decides which trust zone the request lands in: 127.0.0.1 is the café PC and
  // bypasses admin auth, the LAN address is treated as an untrusted phone.
  const isLoopback = host => ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(String(host).toLowerCase())
  const requestOver = (transport, requestPort, pathname, method = 'GET', payload = null, headers = {}, host = '127.0.0.1') => new Promise((resolve, reject) => {
    const req = transport.request({ host, port: requestPort, path: pathname, method, headers, ...(transport === https ? { rejectUnauthorized: false } : {}) }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        const text = buf.toString()
        let json = null
        try { json = JSON.parse(text) } catch {}
        resolve({ status: res.statusCode, body: text, buffer: buf, json, headers: res.headers })
      })
    })
    req.on('error', reject)
    req.setTimeout(8000, () => req.destroy(new Error('request timeout')))
    if (payload) req.write(payload)
    req.end()
  })

  const raw = (pathname, method = 'GET', payload = null, headers = {}, host = '127.0.0.1') =>
    requestOver(http, port, pathname, method, payload, headers, host)

  // HTTPS is generated asynchronously after HTTP is ready. Cache one readiness wait so a
  // security suite making many LAN requests does not open a probe connection for each call.
  let httpsReady = null
  const ensureHttps = () => {
    if (!httpsReady) {
      httpsReady = waitFor(async () => {
        try { return (await requestOver(https, port + 1000, '/api/state', 'GET', null, {}, '127.0.0.1')).status === 200 }
        catch { return false }
      }, { timeoutMs: 20000, intervalMs: 100, label: 'HTTPS server boot' }).catch(error => { httpsReady = null; throw error })
    }
    return httpsReady
  }
  const secureRaw = async (pathname, method = 'GET', payload = null, headers = {}, host = '127.0.0.1') => {
    await ensureHttps()
    return requestOver(https, port + 1000, pathname, method, payload, headers, host)
  }

  // Keep the convenient API helper's old signature, but route non-loopback API calls over
  // TLS. Direct `raw()` remains available for tests that explicitly prove plaintext is
  // rejected; listener stream tests continue to use HTTP because the stream is public.
  const api = (pathname, method = 'GET', body = null, headers = {}, host = '127.0.0.1') => {
    const payload = body ? JSON.stringify(body) : null
    const requestHeaders = { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }
    return (isLoopback(host) ? raw : secureRaw)(pathname, method, payload, requestHeaders, host)
  }

  // Minimal multipart/form-data body, so an upload can be tested without pulling in a
  // dependency. Used to prove the server rejects a file the browser labels as audio.
  const upload = (pathname, { filename, content, mimetype = 'audio/mpeg' }, headers = {}, host = '127.0.0.1') => {
    const boundary = '----rovlitest' + Math.random().toString(16).slice(2)
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${mimetype}\r\n\r\n`)
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
    const payload = Buffer.concat([head, Buffer.from(content), tail])
    const request = isLoopback(host) ? raw : secureRaw
    return request(pathname, 'POST', payload,
      { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': payload.length, ...headers }, host)
  }

  // Opens /live.mp3 and keeps a running byte count, so a test can ask "is audio actually
  // reaching listeners right now" rather than trusting the process list.
  const listen = () => {
    const meter = { bytes: 0, status: null, done: false }
    meter.req = http.get({ host: '127.0.0.1', port, path: '/live.mp3' }, res => {
      meter.status = res.statusCode
      res.on('data', c => { meter.bytes += c.length })
      res.on('end', () => { meter.done = true })
    })
    meter.req.on('error', () => { meter.done = true })
    // Bytes received during a window — the honest signal for "the broadcast is alive".
    meter.sample = async (ms = 3000) => { const before = meter.bytes; await sleep(ms); return meter.bytes - before }
    meter.close = () => { try { meter.req.destroy() } catch {} }
    return meter
  }

  // Talks to the fake updater's control port: what the station asked it to do, and pushing
  // the pretend download forward.
  const controlRequest = pathname => new Promise((resolve, reject) => {
    if (!controlPort) return reject(new Error('updaterScenario ile başlatılmadı'))
    const req = http.get({ host: '127.0.0.1', port: controlPort, path: pathname }, res => {
      let d = ''
      res.on('data', c => { d += c })
      res.on('end', () => { let json = null; try { json = JSON.parse(d) } catch {} resolve({ status: res.statusCode, body: d, json }) })
    })
    req.on('error', reject)
    req.setTimeout(5000, () => req.destroy(new Error('control timeout')))
  })

  const handle = {
    port, dataDir, proc, api, raw, secureRaw, upload, listen, control: controlRequest,
    pid: proc.pid,
    lanIp: lanIp(),
    get output() { return output },
    children: () => ffmpegChildrenOf(proc.pid),
    encoder: () => ffmpegChildrenOf(proc.pid).find(isEncoder),
    decoder: () => ffmpegChildrenOf(proc.pid).find(isDecoder),
    state: async () => (await api('/api/state')).json,
    play: () => api('/api/control', 'POST', { action: 'play' }),
    // `keepData` leaves the folder behind so a test can inspect what was written or boot a
    // second station on the same data — the only way to test what survives a restart.
    async stop({ keepData = false } = {}) {
      // Kill the whole tree: an abrupt parent death is exactly the case where an orphan
      // could survive, and a leaked ffmpeg would poison later tests in the same run.
      const kids = ffmpegChildrenOf(proc.pid)
      try { proc.kill('SIGKILL') } catch {}
      await sleep(400)
      for (const k of kids) if (pidAlive(k.pid)) killPid(k.pid)
      if (!keepData) { try { fs.rmSync(dataDir, { recursive: true, force: true }) } catch {} }
    }
  }

  await waitFor(async () => (await api('/api/state')).status === 200,
    { timeoutMs: 20000, label: 'server boot' })
  await api('/api/rescan', 'POST')
  return handle
}

module.exports = { startServer, makeTone, writeCorrupt, waitFor, sleep, lanIp, ffmpegChildrenOf, pidAlive, killPid, isEncoder, isDecoder }
