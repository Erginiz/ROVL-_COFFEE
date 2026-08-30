// The café PC is on someone else's network, running other business software that must not be
// disturbed — so the station reports OUTWARD instead of anyone connecting in. Three things
// have to hold for that to be safe to ship:
//
//   1. It is silent unless configured, and the configuration lives in the data folder — no
//      installer ever carries a URL or a token.
//   2. It never sends anything that could hurt if it were read by the wrong person: not the
//      admin code, not a session token.
//   3. A failing report is invisible to the café. Music does not stop because a log could
//      not be delivered.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const http = require('http')
const { startServer, makeTone, waitFor, sleep } = require('../helpers/harness.cjs')

// Stands in for whatever the operator points the station at.
function fakeCollector({ failing = false } = {}) {
  const collector = { received: [], failing, calls: 0 }
  collector.server = http.createServer((req, res) => {
    collector.calls++
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      try { collector.received.push({ body: JSON.parse(body), headers: req.headers }) } catch { collector.received.push({ raw: body }) }
      if (collector.failing) { res.writeHead(500); res.end('nope'); return }
      res.writeHead(200); res.end('ok')
    })
  })
  collector.start = () => new Promise(r => collector.server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${collector.server.address().port}/rapor`)))
  collector.stop = () => new Promise(r => collector.server.close(r))
  return collector
}

const writeConfig = (dataDir, config) =>
  fs.writeFileSync(path.join(dataDir, 'report.json'), JSON.stringify(config, null, 2))

test('yapılandırılmamışsa hiçbir şey gönderilmez', { timeout: 120000 }, async t => {
  // The default for every café that never asks for this: complete silence.
  const collector = fakeCollector()
  const url = await collector.start()
  t.after(() => collector.stop())

  const server = await startServer({ music: [makeTone(10)] })
  t.after(() => server.stop())

  const status = await server.api('/api/report/status')
  assert.equal(status.json.configured, false, 'varsayılan kapalı olmalı')

  await sleep(2000)
  assert.equal(collector.calls, 0, 'yapılandırma yokken hiçbir istek gitmemeli')
  assert.ok(!url.includes('kullanılmadı'))   // url exists but was never contacted
})

test('yapılandırıldığında rapor gönderilir ve içeriği doğrudur', { timeout: 120000 }, async t => {
  const collector = fakeCollector()
  const url = await collector.start()
  t.after(() => collector.stop())

  const seed = await startServer({ music: [makeTone(10)] })
  const dataDir = seed.dataDir
  seed.proc.kill('SIGKILL')
  await sleep(600)
  writeConfig(dataDir, { url, enabled: true, label: 'Rovli Coffee', everyHours: 24, token: 'gizli-anahtar' })

  const server = await startServer({ music: [], dataDir })
  t.after(() => server.stop())

  const res = await server.api('/api/report/test', 'POST')
  assert.equal(res.status, 200, `test raporu gönderilebilmeli: ${res.body}`)

  await waitFor(() => collector.received.length > 0, { label: 'rapor ulaştı' })
  const { body, headers } = collector.received[0]

  assert.equal(headers['x-report-token'], 'gizli-anahtar', 'paylaşılan anahtar başlıkta gitmeli')
  assert.ok(body.app?.version, 'sürüm bilgisi olmalı')
  assert.equal(body.station.label, 'Rovli Coffee', 'kafe etiketi olmalı')
  assert.ok(body.network, 'ağ bilgisi olmalı — asıl teşhis buradan çıkıyor')
  // Present as a key even before the check has run: 'not known yet' is information, and its
  // absence would look like an older build that cannot answer the question at all.
  assert.ok('firewall' in body.network, 'güvenlik duvarı hükmü raporda olmalı')
  assert.ok(Array.isArray(body.network.addresses), 'adres listesi olmalı')
  assert.ok(Array.isArray(body.network.reachedVia), 'telefonların ulaştığı adresler olmalı')
  assert.ok(body.engine, 'motor sayaçları olmalı')
  assert.ok(Array.isArray(body.recent), 'son olaylar olmalı')
  assert.equal(typeof body.listeners, 'number', 'dinleyici sayısı olmalı')
})

test('rapor yönetici kodunu veya oturum anahtarını taşımaz', { timeout: 120000 }, async t => {
  // This payload leaves the building. If it carried the admin code, anyone who ever saw a
  // log would hold the keys to the station.
  const collector = fakeCollector()
  const url = await collector.start()
  t.after(() => collector.stop())

  const seed = await startServer({ music: [makeTone(10)] })
  const dataDir = seed.dataDir
  const code = (await seed.api('/api/admin/code')).json.code
  const login = await seed.api('/api/admin/login', 'POST', { code })
  const token = login.json.token
  seed.proc.kill('SIGKILL')
  await sleep(600)
  writeConfig(dataDir, { url, enabled: true })

  const server = await startServer({ music: [], dataDir })
  t.after(() => server.stop())
  await server.api('/api/report/test', 'POST')
  await waitFor(() => collector.received.length > 0, { label: 'rapor ulaştı' })

  const raw = JSON.stringify(collector.received[0].body)
  assert.ok(!raw.includes(code), 'yönetici kodu rapora girmemeli')
  if (token) assert.ok(!raw.includes(token), 'oturum anahtarı rapora girmemeli')
  assert.ok(!/BEGIN (RSA )?PRIVATE KEY/.test(raw), 'sertifika anahtarı rapora girmemeli')
})

test('rapor gönderilemezse istasyon etkilenmez', { timeout: 120000 }, async t => {
  // A collector that is down, or an internet connection that is out, must be a non-event.
  const collector = fakeCollector({ failing: true })
  const url = await collector.start()
  t.after(() => collector.stop())

  const seed = await startServer({ music: [makeTone(20)] })
  const dataDir = seed.dataDir
  seed.proc.kill('SIGKILL')
  await sleep(600)
  writeConfig(dataDir, { url, enabled: true })

  const server = await startServer({ music: [], dataDir })
  t.after(() => server.stop())

  const res = await server.api('/api/report/test', 'POST')
  assert.equal(res.status, 400, 'başarısız gönderim operatöre bildirilmeli')

  // The station has to be completely unbothered: still serving, still playing.
  await server.play()
  const meter = server.listen()
  t.after(() => meter.close())
  await waitFor(() => meter.status === 200, { label: '/live.mp3' })
  assert.ok((await meter.sample(3000)) > 5000, 'rapor başarısızken de yayın akmalı')

  const state = await server.state()
  assert.ok(state.playback, 'API çalışmaya devam etmeli')
})

test('geçersiz yapılandırma sessizce yok sayılır', { timeout: 120000 }, async t => {
  // A half-edited or mistyped report.json must not break boot — the café would lose its
  // music over a typo in a file that is only there for convenience.
  const seed = await startServer({ music: [makeTone(10)] })
  const dataDir = seed.dataDir
  seed.proc.kill('SIGKILL')
  await sleep(600)
  fs.writeFileSync(path.join(dataDir, 'report.json'), '{ bu gecerli json degil')

  const server = await startServer({ music: [], dataDir })
  t.after(() => server.stop())

  const status = await server.api('/api/report/status')
  assert.equal(status.json.configured, false, 'bozuk yapılandırma kapalı sayılmalı')
  const state = await server.state()
  assert.ok(state.playback, 'istasyon normal çalışmalı')
})
