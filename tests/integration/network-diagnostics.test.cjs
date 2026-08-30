// A café with two networks (a second router was added) leaves the operator guessing which
// of the PC's addresses the phones can actually see, and a wrong guess is indistinguishable
// from a broken app: the QR opens nothing and the screen explains nothing.
//
// The server does not have to guess. Every request arrives on a specific local interface,
// so it can report which address phones genuinely reached — and refuse, out loud, an address
// this machine no longer has.

const test = require('node:test')
const assert = require('node:assert')
const http = require('http')
const { startServer, makeTone, waitFor, lanIp } = require('../helpers/harness.cjs')

const LAN = lanIp()
const skip = LAN ? false : 'bu makinede LAN adresi yok'

test('telefonun ulaştığı adres kaydedilir ve panele bildirilir', { skip, timeout: 120000 }, async t => {
  const server = await startServer({ music: [makeTone(10)] })
  t.after(() => server.stop())

  // Nothing has come in from the network yet.
  const before = await server.state()
  assert.deepEqual(before.network.reachedVia, [], 'başlangıçta kayıt olmamalı')

  // A phone arrives over the LAN address (this is what scanning the QR does).
  await server.api('/api/state', 'GET', null, {}, LAN)
  await server.api('/api/listeners/heartbeat', 'POST', { id: 'telefon-1' }, {}, LAN)

  const after = await server.state()
  const ips = after.network.reachedVia.map(r => r.ip)
  assert.ok(ips.includes(LAN), `telefonun ulaştığı adres (${LAN}) raporlanmalı, görülen: ${ips.join(',')}`)
  assert.ok(after.network.reachedVia[0].lastAt, 'son ulaşma zamanı kaydedilmeli')
})

test('kafe bilgisayarının kendi isteği "telefon bağlandı" saymaz', { timeout: 120000 }, async t => {
  // Otherwise the panel would claim phones are connecting when only the desk PC is talking
  // to itself — the exact false reassurance an operator must not be given while customers
  // are telling them it does not work.
  const server = await startServer({ music: [makeTone(10)] })
  t.after(() => server.stop())

  for (let i = 0; i < 3; i++) await server.api('/api/state')
  await server.api('/api/listeners/heartbeat', 'POST', { id: 'masaustu' })

  const state = await server.state()
  assert.deepEqual(state.network.reachedVia, [], 'localhost istekleri sayılmamalı')
})

test('yayın akışına bağlanan telefon da kaydedilir', { skip, timeout: 120000 }, async t => {
  // Reaching the page but not the audio is a distinct failure; recording the stream request
  // separately is what tells those two apart.
  const server = await startServer({ music: [makeTone(10)] })
  t.after(() => server.stop())

  await new Promise(resolve => {
    const req = http.get({ host: LAN, port: server.port, path: '/live.mp3' }, res => { res.destroy(); resolve() })
    req.on('error', () => resolve())
  })

  const state = await waitFor(async () => {
    const s = await server.state()
    return s.network.reachedVia.some(r => r.ip === LAN) ? s : null
  }, { timeoutMs: 10000, label: 'yayın isteği kaydedildi' })
  assert.ok(state.network.reachedVia.some(r => r.ip === LAN), 'yayına bağlanan telefon raporlanmalı')
})

test('bu makinede olmayan bir ağ adresi seçilemez ve sebebi söylenir', { timeout: 120000 }, async t => {
  // The operator picks an address that has since disappeared (Wi-Fi dropped, router
  // swapped). Silently keeping the old value made the selector look broken.
  const server = await startServer({ music: [makeTone(10)] })
  t.after(() => server.stop())

  const res = await server.api('/api/settings', 'PATCH', { station: { preferredIp: '10.99.99.99' } })
  assert.equal(res.status, 400, 'olmayan adres reddedilmeli')
  assert.match(res.json.error, /10\.99\.99\.99/, 'hata mesajı hangi adres olduğunu söylemeli')

  const state = await server.state()
  assert.notEqual(state.station.preferredIp, '10.99.99.99', 'geçersiz adres kaydedilmemeli')
})

test('gerçek bir adres seçilebilir ve QR onu gösterir', { skip, timeout: 120000 }, async t => {
  // The guard must not block the legitimate case it exists for.
  const server = await startServer({ music: [makeTone(10)] })
  t.after(() => server.stop())

  const res = await server.api('/api/settings', 'PATCH', { station: { preferredIp: LAN } })
  assert.equal(res.status, 200, 'gerçek adres kabul edilmeli')
  assert.equal(res.json.network.ip, LAN, 'QR seçilen adresi göstermeli')
  assert.ok(res.json.network.webUrl.includes(LAN), 'bağlantı adresi seçilen IP ile kurulmalı')
  assert.equal(res.json.network.preferredMissing, false, 'seçili adres mevcutken uyarı olmamalı')
})

test('kayıtlı adres kaybolduğunda uyarı verilir ve yayın durmaz', { timeout: 120000 }, async t => {
  // The café's situation: the saved address belonged to a network that is gone. The station
  // must keep working on whatever address it does have, and say that the QR moved.
  const fs = require('fs')
  const path = require('path')
  const seed = await startServer({ music: [makeTone(10)] })
  const dataDir = seed.dataDir
  const statePath = path.join(dataDir, 'station.json')
  const saved = await waitFor(() => {
    try { const s = JSON.parse(fs.readFileSync(statePath, 'utf8')); return s.music?.length ? s : null } catch { return null }
  }, { timeoutMs: 25000, label: 'durum yazıldı' })
  seed.proc.kill('SIGKILL')
  await new Promise(r => setTimeout(r, 600))

  saved.station.preferredIp = '10.77.77.77'   // an address from a network that no longer exists
  fs.writeFileSync(statePath, JSON.stringify(saved, null, 2))

  const server = await startServer({ music: [], dataDir })
  t.after(() => server.stop())

  const state = await server.state()
  assert.equal(state.network.preferredMissing, true, 'kayıp adres için uyarı verilmeli')
  assert.notEqual(state.network.ip, '10.77.77.77', 'yayın var olan bir adrese düşmeli')
  assert.ok(state.network.webUrl.includes(state.network.ip), 'bağlantı adresi geçerli olmalı')
})

// The café's unsolved problem: phones stopped connecting after a new router, the address on
// screen was right, the page never loaded. A Windows firewall rule scoped to a profile the PC
// is no longer on produces exactly that, and nothing in the app could see it — diagnosing it
// needed someone on site to run a script.
//
// The verdict logic is pinned down in tests/unit/firewall-check.test.cjs, where every branch
// is reachable. What can be checked against a running station is that the check happens, that
// its answer reaches the panel, and — most important — that a machine which cannot answer is
// left alone rather than warned about.
test('güvenlik duvarı durumu panele ulaşır', { timeout: 120000 }, async t => {
  const server = await startServer({ music: [] })
  t.after(() => server.stop())

  const firewall = await waitFor(async () => (await server.state()).network.firewall,
    { timeoutMs: 60000, label: 'güvenlik duvarı kontrolü' })

  assert.equal(typeof firewall.problem, 'boolean')
  assert.ok(Array.isArray(firewall.networks), 'ağ listesi olmalı')
  if (firewall.problem) {
    assert.ok(firewall.message, 'sorun varsa ne yapılacağı yazılmalı')
  } else {
    assert.equal(firewall.message, null, 'sorun yokken mesaj olmamalı')
  }
})

test('kontrol tamamlanmadan panel bozulmaz', async t => {
  // It takes seconds. Everything the operator looks at has to work before it lands, and
  // `null` has to mean "not known yet" rather than "no problem" or a crash.
  const server = await startServer({ music: [] })
  t.after(() => server.stop())

  const network = (await server.state()).network
  assert.ok(network.ip, 'adres hemen gelmeli')
  assert.ok(Array.isArray(network.ips))
  assert.ok(network.firewall === null || typeof network.firewall === 'object')
})
