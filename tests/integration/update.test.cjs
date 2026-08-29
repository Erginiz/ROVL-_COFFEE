// The update button is how a fix reaches a café nobody is going to drive to. That makes two
// things load-bearing, and neither is obvious from the happy path:
//
//   1. Installing STOPS THE MUSIC and raises a Windows permission prompt. It must never fire
//      by accident — not from a phone left unlocked on a table, and not when there is nothing
//      downloaded (which would close the station and install nothing: "the music just stopped").
//   2. A station running from source, or one that cannot reach GitHub, must keep playing and
//      say so plainly. An update mechanism that can take the café off the air when the network
//      is down would be worse than no update mechanism.
//
// A fake updater stands in for electron-updater, so none of this needs Electron or a release.

const test = require('node:test')
const assert = require('node:assert')
const { startServer, makeTone, waitFor, lanIp } = require('../helpers/harness.cjs')

const LAN = lanIp()

test('güncelleyici olmayan kurulumda panel bozulmaz', { timeout: 120000 }, async t => {
  // Running from source (npm start) there is nothing to update. The panel has to be told
  // that clearly rather than showing a button that cannot work.
  const server = await startServer({ music: [makeTone(10)] })
  t.after(() => server.stop())

  const res = await server.api('/api/update/status')
  assert.equal(res.status, 200)
  assert.equal(res.json.supported, false, 'kaynaktan çalışırken güncelleme kapalı olmalı')
  assert.ok(res.json.version, 'sürüm yine de bildirilmeli')

  const install = await server.api('/api/update/install', 'POST')
  assert.equal(install.status, 400, 'güncelleyici yokken kurulum denenmemeli')
})

test('indirme sürerken durum ve yüzde bildirilir', { timeout: 120000 }, async t => {
  const server = await startServer({ music: [makeTone(10)], updaterScenario: 'downloading' })
  t.after(() => server.stop())

  const res = await server.api('/api/update/status')
  assert.equal(res.json.supported, true)
  assert.equal(res.json.downloading, true, 'indirme durumu görünmeli')
  assert.equal(res.json.percent, 42, 'yüzde bildirilmeli')
  assert.equal(res.json.newVersion, '0.3.3')
})

test('indirme bitmeden kurulum reddedilir', { timeout: 120000 }, async t => {
  // quitAndInstall with nothing downloaded closes the station and installs nothing. From the
  // café's side that is indistinguishable from a crash.
  const server = await startServer({ music: [makeTone(10)], updaterScenario: 'downloading' })
  t.after(() => server.stop())

  const res = await server.api('/api/update/install', 'POST')
  assert.equal(res.status, 409, 'indirilmemiş güncelleme kurulmamalı')

  const calls = await server.control('/calls')
  assert.equal(calls.json.install, 0, 'güncelleyiciye kurulum emri gitmemeli')
})

test('indirme bitince kurulum gerçekten tetiklenir', { timeout: 120000 }, async t => {
  // The whole point: pressing the button must reach the updater, not just return 200.
  const server = await startServer({ music: [makeTone(10)], updaterScenario: 'downloaded' })
  t.after(() => server.stop())

  const status = await server.api('/api/update/status')
  assert.equal(status.json.downloaded, true, 'hazır güncelleme görünmeli')

  const res = await server.api('/api/update/install', 'POST')
  assert.equal(res.status, 200, `kurulum başlatılabilmeli: ${res.body}`)
  assert.equal(res.json.installing, true)

  const calls = await server.control('/calls')
  assert.equal(calls.json.install, 1, 'güncelleyiciye tam olarak bir kurulum emri gitmeli')

  // And the operator gets a record of it — an update that restarts the station should not be
  // a mystery in the history afterwards.
  const state = await server.state()
  assert.ok((state.history || []).some(h => /Güncelleme kuruluyor/i.test(h.title)),
    'kurulum geçmişe yazılmalı')
})

test('kurulum yalnızca kafe bilgisayarından tetiklenebilir', { skip: LAN ? false : 'LAN adresi yok', timeout: 120000 }, async t => {
  // Installing takes the station off the air. A phone — including one someone left unlocked
  // on a table — must not be able to do that from across the room.
  const server = await startServer({ music: [makeTone(10)], updaterScenario: 'downloaded' })
  t.after(() => server.stop())

  const code = (await server.api('/api/admin/code')).json.code
  const { json: { token } } = await server.api('/api/admin/login', 'POST', { code }, {}, LAN)

  const res = await server.api('/api/update/install', 'POST', null, { 'x-admin-token': token }, LAN)
  assert.equal(res.status, 403, 'giriş yapmış telefon bile kurulumu başlatamamalı')

  const calls = await server.control('/calls')
  assert.equal(calls.json.install, 0, 'güncelleyiciye emir gitmemeli')

  // But seeing the version from a phone is fine — that is just information.
  const status = await server.api('/api/update/status', 'GET', null, { 'x-admin-token': token }, LAN)
  assert.equal(status.status, 200, 'yönetici durumu telefondan görebilmeli')
})

test('güncelleme durumu giriş yapmamış telefona kapalı', { skip: LAN ? false : 'LAN adresi yok', timeout: 120000 }, async t => {
  const server = await startServer({ music: [makeTone(10)], updaterScenario: 'downloaded' })
  t.after(() => server.stop())

  assert.equal((await server.api('/api/update/status', 'GET', null, {}, LAN)).status, 403)
  assert.equal((await server.api('/api/update/check', 'POST', null, {}, LAN)).status, 403)
})

test('güncelleme hatası yayını etkilemez', { timeout: 120000 }, async t => {
  // No internet, GitHub down, a malformed release: the café keeps playing and the reason is
  // visible on the panel.
  const server = await startServer({ music: [makeTone(20)], updaterScenario: 'error' })
  t.after(() => server.stop())

  const status = await server.api('/api/update/status')
  assert.ok(status.json.error, 'hata operatöre gösterilmeli')
  assert.equal(status.json.downloaded, false)

  await server.play()
  const meter = server.listen()
  t.after(() => meter.close())
  await waitFor(() => meter.status === 200, { label: '/live.mp3' })
  assert.ok((await meter.sample(3000)) > 5000, 'güncelleme hatasına rağmen yayın akmalı')
})

test('elle denetleme güncelleyiciye ulaşır', { timeout: 120000 }, async t => {
  const server = await startServer({ music: [makeTone(10)], updaterScenario: 'idle' })
  t.after(() => server.stop())

  const res = await server.api('/api/update/check', 'POST')
  assert.equal(res.status, 200)
  const calls = await server.control('/calls')
  assert.equal(calls.json.check, 1, 'denetleme emri güncelleyiciye gitmeli')
})

test('indirme tamamlandığında durum "hazır"a döner', { timeout: 120000 }, async t => {
  // The state the panel's button waits for.
  const server = await startServer({ music: [makeTone(10)], updaterScenario: 'downloading' })
  t.after(() => server.stop())

  assert.equal((await server.api('/api/update/status')).json.downloaded, false)
  await server.control('/finish-download')

  const ready = await waitFor(async () => {
    const s = await server.api('/api/update/status')
    return s.json.downloaded ? s.json : null
  }, { timeoutMs: 10000, label: 'indirme tamamlandı' })
  assert.equal(ready.percent, 100)
  assert.equal(ready.newVersion, '0.3.3')
})
