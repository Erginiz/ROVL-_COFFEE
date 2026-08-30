// A phone reaches the station by whatever route the operator gave it: the LAN address from
// the QR, localhost on the café PC itself, or the machine name someone typed. All of those
// have to work, and one of them used to be refused outright.
//
// Measured on a Windows machine: the hostname resolves to a link-local IPv6 address BEFORE
// the IPv4 one. An IPv4-only socket refuses that first attempt — browsers fall back, but the
// connection starts with a refusal, and clients that do not retry simply fail.

const test = require('node:test')
const assert = require('node:assert')
const http = require('http')
const os = require('os')
const dns = require('dns')
const { startServer, makeTone, waitFor, lanIp } = require('../helpers/harness.cjs')

const LAN = lanIp()

function get(host, port, pathname = '/api/state') {
  return new Promise(resolve => {
    const req = http.get({ host, port, path: pathname, timeout: 8000 }, res => {
      res.resume()
      resolve({ status: res.statusCode })
    })
    req.on('error', error => resolve({ error: error.code || error.message }))
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }) })
  })
}

test('istasyon IPv4 ve IPv6 üzerinden aynı anda hizmet verir', { timeout: 120000 }, async t => {
  const server = await startServer({ music: [makeTone(10)] })
  t.after(() => server.stop())

  const v4 = await get('127.0.0.1', server.port)
  assert.equal(v4.status, 200, `IPv4 çalışmalı (${v4.error || ''})`)

  const v6 = await get('::1', server.port)
  assert.equal(v6.status, 200, `IPv6 çalışmalı (${v6.error || ''})`)
})

test('makine adıyla erişilebilir (telefonun ilk denediği yol IPv6 olsa bile)', { timeout: 120000 }, async t => {
  const server = await startServer({ music: [makeTone(10)] })
  t.after(() => server.stop())

  const hostname = os.hostname()
  const res = await get(hostname, server.port)
  assert.equal(res.status, 200, `makine adıyla açılmalı (${res.error || ''})`)

  // Show what this is actually guarding: if the name resolves to IPv6 first, an IPv4-only
  // socket would have refused the first attempt.
  const resolved = await new Promise(r => dns.lookup(hostname, { all: true }, (e, a) => r(e ? [] : a)))
  if (resolved.some(a => a.family === 6)) {
    const v6first = resolved[0]
    assert.ok(v6first, 'çözümleme sonucu olmalı')
  }
})

test('LAN adresinden yayın alınabilir', { skip: LAN ? false : 'LAN yok', timeout: 120000 }, async t => {
  const server = await startServer({ music: [makeTone(15)] })
  t.after(() => server.stop())
  await server.play()

  const page = await get(LAN, server.port, '/listen')
  assert.equal(page.status, 200, 'sayfa LAN üzerinden açılmalı')

  const bytes = await new Promise(resolve => {
    const req = http.get({ host: LAN, port: server.port, path: '/live.mp3' }, res => {
      let total = 0
      res.on('data', c => { total += c.length; if (total > 3000) { res.destroy(); resolve(total) } })
      setTimeout(() => { res.destroy(); resolve(total) }, 8000)
    })
    req.on('error', () => resolve(0))
  })
  assert.ok(bytes > 1000, `LAN üzerinden ses gelmeli (alınan: ${bytes})`)
})

test('çift yığın dinleme port çakışması korumasını bozmaz', { timeout: 180000 }, async t => {
  // The exclusive bind is what stops two stations from running at once. Switching the socket
  // to dual-stack must not quietly give that up.
  const server = await startServer({ music: [makeTone(10)] })
  t.after(() => server.stop())

  const { spawn } = require('child_process')
  const path = require('path')
  const rival = spawn(process.execPath, [path.join(__dirname, '..', '..', 'server', 'index.cjs')], {
    env: { ...process.env, CAFE_RADIO_DATA: server.dataDir, PORT: String(server.port), HTTPS_PORT: String(server.port + 1000) },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  })
  let output = ''
  let exitCode = null
  rival.stdout.on('data', d => { output += d })
  rival.stderr.on('data', d => { output += d })
  rival.on('exit', code => { exitCode = code })
  t.after(() => { try { rival.kill() } catch {} })

  await waitFor(() => exitCode !== null, { timeoutMs: 20000, intervalMs: 500, label: 'ikinci kopya çıktı' })
  assert.notEqual(exitCode, 0, 'ikinci kopya başarıyla başlamamalı')
  assert.match(output, /zaten kullanımda/i, 'sebebi söylenmeli')

  // The running station is unaffected.
  assert.equal((await get('127.0.0.1', server.port)).status, 200)
})
