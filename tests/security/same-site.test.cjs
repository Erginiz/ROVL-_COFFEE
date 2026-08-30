// The cross-site write guard protects a station that every customer's phone can reach. Its
// rule has to be exactly right in both directions:
//
//   Too loose → a malicious page open in any browser on the café Wi-Fi can control the music.
//   Too tight → the café's own phones are refused. That failure is nastier than it sounds:
//               GETs still work, so the page loads and the audio plays, while the listener
//               count, the phone login and the announcement all fail SILENTLY. It looks
//               exactly like "the app is broken" with nothing on screen to explain it.
//
// The original rule compared the Origin only against the machine's IPv4 addresses, so
// reaching the PC by its Windows name — http://KAFE-PC:8090, which works on any LAN —
// failed the second way.

const test = require('node:test')
const assert = require('node:assert')
const os = require('os')
const { startServer, makeTone, lanIp } = require('../helpers/harness.cjs')

const LAN = lanIp()
const HOSTNAME = os.hostname()

test('makine adıyla açılan sayfadan gelen yazma kabul edilir', { timeout: 120000 }, async t => {
  // A phone that reached the station as http://<pc-adı>:8090 sends that name as its Origin.
  const server = await startServer({ music: [makeTone(10)] })
  t.after(() => server.stop())

  const res = await server.api('/api/control', 'POST', { action: 'pause' },
    { Origin: `http://${HOSTNAME}:${server.port}`, Host: `${HOSTNAME}:${server.port}` })
  assert.equal(res.status, 200, 'kendi makine adımızdan gelen istek reddedilmemeli')
})

test('IP ile açılan sayfadan gelen yazma origin yüzünden reddedilmez', { skip: LAN ? false : 'LAN yok', timeout: 120000 }, async t => {
  // A LAN request still needs an admin token — that is a separate guard. What matters here
  // is that it is refused for the RIGHT reason: by the login check, never by the cross-site
  // check, which would mean the café's own page was being treated as a foreign site.
  const server = await startServer({ music: [makeTone(10)] })
  t.after(() => server.stop())

  const code = (await server.api('/api/admin/code')).json.code
  const { json: { token } } = await server.api('/api/admin/login', 'POST', { code }, {}, LAN)
  const res = await server.api('/api/control', 'POST', { action: 'pause' },
    { Origin: `http://${LAN}:${server.port}`, 'x-admin-token': token }, LAN)
  assert.equal(res.status, 200, 'giriş yapmış telefon kendi sayfasından yayını yönetebilmeli')
})

test('yabancı site hâlâ reddedilir', { timeout: 120000 }, async t => {
  // The reason the guard exists: a page on the café Wi-Fi must not be able to drive the music.
  const server = await startServer({ music: [makeTone(10)] })
  t.after(() => server.stop())

  for (const origin of ['http://evil.example.com', 'https://kotu-site.net:8090', 'http://192.0.2.1:8090']) {
    const res = await server.api('/api/control', 'POST', { action: 'pause' }, { Origin: origin })
    assert.equal(res.status, 403, `${origin} reddedilmeli`)
  }
})

test('kendi adımıza benzeyen sahte origin reddedilir', { timeout: 120000 }, async t => {
  // The check compares the Origin's hostname to the host the request was addressed to, so a
  // lookalike must not slip through on a substring.
  const server = await startServer({ music: [makeTone(10)] })
  t.after(() => server.stop())

  for (const origin of [`http://${HOSTNAME}.evil.com`, `http://evil-${HOSTNAME}`, 'http://127.0.0.1.evil.com']) {
    const res = await server.api('/api/control', 'POST', { action: 'pause' }, { Origin: origin })
    assert.equal(res.status, 403, `${origin} reddedilmeli`)
  }
})

test('bozuk origin başlığı reddedilir', { timeout: 120000 }, async t => {
  const server = await startServer({ music: [makeTone(10)] })
  t.after(() => server.stop())
  const res = await server.api('/api/control', 'POST', { action: 'pause' }, { Origin: 'bu-bir-url-degil' })
  assert.equal(res.status, 403, 'ayrıştırılamayan origin reddedilmeli')
})

test('origin göndermeyen istemciler (Electron, curl) engellenmez', { timeout: 120000 }, async t => {
  // The desk app and the diagnostic script send no Origin at all; blocking those would break
  // the café's own panel.
  const server = await startServer({ music: [makeTone(10)] })
  t.after(() => server.stop())
  const res = await server.api('/api/control', 'POST', { action: 'pause' })
  assert.equal(res.status, 200)
})

test('okuma istekleri hiçbir zaman engellenmez', { timeout: 120000 }, async t => {
  // A phone must be able to see the station and hear it regardless of Origin games.
  const server = await startServer({ music: [makeTone(10)] })
  t.after(() => server.stop())
  const res = await server.api('/api/state', 'GET', null, { Origin: 'http://evil.example.com' })
  assert.equal(res.status, 200, 'GET istekleri origin yüzünden reddedilmemeli')
})
