// How the station serves its own UI, and how it behaves when a request is wrong. This is the
// layer the café actually touches first: a phone scans the QR and either gets a page or does
// not. Nothing below here matters if this part is broken.

const test = require('node:test')
const assert = require('node:assert')
const { startServer, makeTone, lanIp } = require('../helpers/harness.cjs')

const LAN = lanIp()

test('QR kodu üretilir ve bağlantı adresini taşır', { timeout: 120000 }, async t => {
  const server = await startServer({ music: [makeTone(10)] })
  t.after(() => server.stop())

  const res = await server.api('/api/qr')
  assert.equal(res.status, 200)
  assert.match(res.json.dataUrl, /^data:image\/png;base64,/, 'PNG veri adresi dönmeli')
  assert.ok(res.json.dataUrl.length > 500, 'gerçek bir görsel üretilmeli')

  // The QR has to encode the address the panel is showing, or the phone lands somewhere else.
  const state = await server.state()
  assert.ok(state.network.webUrl.includes(state.network.ip), 'bağlantı adresi seçili IP ile kurulmalı')
  assert.match(state.network.webUrl, /\/listen$/, 'QR dinleme sayfasına gitmeli')
})

test('dinleyici sayfası her yoldan açılır (tek sayfa uygulaması)', { timeout: 120000 }, async t => {
  // A phone may arrive at /listen, at the root, or at a path the operator typed by hand. All
  // of them must serve the app rather than a 404 the customer cannot interpret.
  const server = await startServer({ music: [makeTone(10)] })
  t.after(() => server.stop())

  for (const route of ['/', '/listen', '/admin', '/bilinmeyen-sayfa']) {
    const res = await server.raw(route, 'GET')
    assert.equal(res.status, 200, `${route} sayfayı sunmalı`)
    assert.match(res.body, /<div id="root">|<!doctype html>/i, `${route} uygulama kabuğunu döndürmeli`)
  }
})

test('sayfa önbelleğe alınmaz (güncelleme sonrası eski arayüz kalmaz)', { timeout: 120000 }, async t => {
  // The bundle is content-hashed, but the shell that points at it must not be cached — or a
  // phone keeps loading yesterday's app after an update.
  const server = await startServer({ music: [makeTone(10)] })
  t.after(() => server.stop())

  const res = await server.raw('/listen', 'GET')
  const cache = String(res.headers['cache-control'] || '')
  assert.match(cache, /no-cache|no-store/, `kabuk HTML önbelleğe alınmamalı (başlık: ${cache})`)
})

test('yayın akışı doğru başlıklarla sunulur', { timeout: 120000 }, async t => {
  const server = await startServer({ music: [makeTone(10)] })
  t.after(() => server.stop())
  await server.play()

  const headers = await new Promise(resolve => {
    const req = require('http').get({ host: '127.0.0.1', port: server.port, path: '/live.mp3' }, res => {
      const h = res.headers
      res.destroy()
      resolve({ status: res.statusCode, ...h })
    })
    req.on('error', () => resolve({}))
  })
  assert.equal(headers.status, 200)
  assert.match(String(headers['content-type']), /audio\/mpeg/, 'MP3 olarak sunulmalı')
  assert.match(String(headers['cache-control'] || ''), /no-store|no-cache/, 'canlı yayın önbelleğe alınmamalı')
})

test('bilinmeyen kontrol komutu istasyonu bozmaz', { timeout: 120000 }, async t => {
  // A stale phone running an older bundle can send an action this build no longer knows.
  const server = await startServer({ music: [makeTone(15)] })
  t.after(() => server.stop())
  await server.play()

  for (const action of ['bilinmeyen', '', null, 12345, { nested: true }]) {
    const res = await server.api('/api/control', 'POST', { action })
    assert.ok(res.status < 500, `action=${JSON.stringify(action)} sunucu hatası vermemeli (${res.status})`)
  }
  const state = await server.state()
  assert.ok(state.playback, 'istasyon çalışmaya devam etmeli')
})

test('bozuk JSON gövdesi temiz hata döndürür', { timeout: 120000 }, async t => {
  // Not a 500 with an HTML stack trace: the phone shows what comes back.
  const server = await startServer({ music: [makeTone(10)] })
  t.after(() => server.stop())

  const res = await server.raw('/api/control', 'POST', '{ bu json degil',
    { 'Content-Type': 'application/json' })
  assert.ok(res.status >= 400 && res.status < 500, `istemci hatası dönmeli (${res.status})`)
  assert.doesNotMatch(res.body, /<html/i, 'HTML hata sayfası dönmemeli')
})

test('geçersiz medya türü reddedilir', { timeout: 120000 }, async t => {
  // The kind comes straight from the URL and is used to pick a folder on disk.
  const server = await startServer({ music: [makeTone(10)] })
  t.after(() => server.stop())

  for (const kind of ['jingle', 'sistem', '..', 'constructor', 'prototype']) {
    const res = await server.api(`/api/media/${encodeURIComponent(kind)}`, 'POST')
    assert.ok(res.status === 404 || res.status === 400,
      `${kind} reddedilmeli (dönen: ${res.status})`)
  }
})

test('olmayan parçayı silmek 404 döner', { timeout: 120000 }, async t => {
  const server = await startServer({ music: [makeTone(10)] })
  t.after(() => server.stop())
  const res = await server.api('/api/media/music/olmayan-id', 'DELETE')
  assert.equal(res.status, 404)
})

test('LAN’dan gelen dinleyici sayfayı ve yayını alabilir', { skip: LAN ? false : 'LAN yok', timeout: 120000 }, async t => {
  // The end-to-end promise: scan the QR, get the page, hear the music — with no code.
  const server = await startServer({ music: [makeTone(15)] })
  t.after(() => server.stop())
  await server.play()

  const page = await server.raw('/listen', 'GET', null, {}, LAN)
  assert.equal(page.status, 200, 'sayfa LAN üzerinden açılmalı')

  const stream = await new Promise(resolve => {
    const req = require('http').get({ host: LAN, port: server.port, path: '/live.mp3' }, res => {
      let bytes = 0
      res.on('data', c => { bytes += c.length; if (bytes > 2000) { res.destroy(); resolve(bytes) } })
      setTimeout(() => { res.destroy(); resolve(bytes) }, 6000)
    })
    req.on('error', () => resolve(0))
  })
  assert.ok(stream > 1000, `LAN üzerinden ses gelmeli (alınan: ${stream} bayt)`)
})
