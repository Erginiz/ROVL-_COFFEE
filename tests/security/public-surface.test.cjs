// Everyone in the café is on the same Wi-Fi as the station, so every endpoint is one
// unauthenticated request away from a customer. This test pins the whole public surface:
// exactly the endpoints a listener needs are open, and everything else refuses.
//
// Its real job is the future. An endpoint added later without a guard — the easiest mistake
// to make in this codebase, since the desk PC bypasses auth and the developer never notices —
// fails here instead of shipping.

const test = require('node:test')
const assert = require('node:assert')
const { startServer, makeTone, lanIp } = require('../helpers/harness.cjs')

const LAN = lanIp()
const skip = LAN ? false : 'bu makinede LAN adresi yok (herkese açık yüzey test edilemez)'

// What a phone that has scanned the QR must be able to do WITHOUT any code: see what is
// playing, subscribe to updates, hear the stream, count itself, and log in.
const PUBLIC = [
  ['GET', '/api/state', null],
  ['GET', '/api/qr', null],
  ['POST', '/api/listeners/heartbeat', { id: 'phone-1' }]
]
// /api/admin/login is deliberately not in that list: it answers 403 to a wrong code, which
// is indistinguishable by status from being blocked. That it accepts a CORRECT code from the
// LAN is covered in auth.test.cjs, where the real code is available.

// Everything that changes the station, reads the library, or reveals the code.
const GUARDED = [
  ['POST', '/api/control', { action: 'pause' }],
  ['PATCH', '/api/settings', { playback: { shuffle: true } }],
  ['POST', '/api/rescan', null],
  ['POST', '/api/open-folder/music', null],
  ['POST', '/api/media/music', null],
  ['DELETE', '/api/media/music/any-id', null],
  ['POST', '/api/mic/chunk', null],
  ['POST', '/api/mic/end', null],
  ['GET', '/api/admin/code', null],
  ['POST', '/api/admin/rotate', null],
  ['GET', '/media/music/anything.mp3', null],
  ['GET', '/media/ad/anything.mp3', null]
]

test('dinleyicinin ihtiyaç duyduğu uçlar koda gerek olmadan çalışır', { skip, timeout: 120000 }, async t => {
  const server = await startServer({ music: [makeTone(10)] })
  t.after(() => server.stop())

  for (const [method, path, body] of PUBLIC) {
    const res = await server.api(path, method, body, {}, LAN)
    assert.notEqual(res.status, 403, `${method} ${path} misafire kapalı olmamalı (QR okutan telefon çalışmalı)`)
    assert.ok(res.status < 500, `${method} ${path} sunucu hatası vermemeli (dönen: ${res.status})`)
  }
})

test('geri kalan her uç giriş yapmamış telefona kapalı', { skip, timeout: 120000 }, async t => {
  const server = await startServer({ music: [makeTone(10)] })
  t.after(() => server.stop())

  for (const [method, path, body] of GUARDED) {
    const res = await server.api(path, method, body, {}, LAN)
    assert.equal(res.status, 403, `${method} ${path} tokensiz erişime kapalı olmalı (dönen: ${res.status})`)
  }
})

test('yayın akışı herkese açık kalır', { skip, timeout: 120000 }, async t => {
  // The whole point of the product: scan, press play, hear the café's music.
  const server = await startServer({ music: [makeTone(10)] })
  t.after(() => server.stop())

  const status = await new Promise(resolve => {
    const req = require('http').get({ host: LAN, port: server.port, path: '/live.mp3' }, res => {
      res.destroy(); resolve(res.statusCode)
    })
    req.on('error', () => resolve(0))
  })
  assert.equal(status, 200, 'canlı yayın kod istemeden dinlenebilmeli')
})

test('kaldırılan uçlar geri gelmez', { skip: false, timeout: 120000 }, async t => {
  // /api/current-track served a feature that no longer exists and handed out a /media URL
  // that is now refused anyway. If it reappears, it reappears unauthenticated.
  const server = await startServer({ music: [makeTone(10)] })
  t.after(() => server.stop())

  const res = await server.api('/api/current-track')
  // The SPA fallback answers unknown GETs with the app shell, so "not JSON" is the signal.
  assert.ok(!res.json || !res.json.url, '/api/current-track artık veri döndürmemeli')
})
