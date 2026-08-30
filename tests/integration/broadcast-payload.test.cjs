// Every state change is pushed to every connected phone as a whole snapshot, and the music
// library is 61% of it. Measured: a realistic café broadcasts about 258 times an hour (mostly
// the 15-second tick), so a 200-song library costs roughly 16 MB per phone per hour — more
// than the 128 kbps audio stream itself, on the same Wi-Fi, to send a list that has not
// changed since the last time it was sent.
//
// So the library is sent when a client attaches and whenever it actually changes, and left
// out otherwise. The client keeps what it already has.

const test = require('node:test')
const assert = require('node:assert')
const http = require('node:http')
const fs2 = require('node:fs')
const { startServer, makeTone, sleep } = require('../helpers/harness.cjs')

// Collects the SSE frames as parsed objects, the way the phone's EventSource sees them.
function openEvents(port) {
  const frames = []
  const request = http.get({ host: '127.0.0.1', port, path: '/api/events' }, response => {
    let buffer = ''
    response.on('data', chunk => {
      buffer += chunk.toString()
      let index
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        const line = buffer.slice(0, index).replace(/^data: /, '')
        buffer = buffer.slice(index + 2)
        try { frames.push(JSON.parse(line)) } catch {}
      }
    })
  })
  // Tearing down a live stream is how this connection always ends, and an unhandled
  // ECONNRESET from that would fail the test for the teardown rather than the assertion.
  request.on('error', () => {})
  return { frames, close: () => request.destroy() }
}

test('bağlanan telefon kütüphaneyi ilk karede eksiksiz alır', async t => {
  // Without this the phone would have nothing to keep, and every later frame would be a
  // delta against nothing.
  const server = await startServer({ music: [makeTone(6, 440), makeTone(6, 660)] })
  t.after(() => server.stop())
  const events = openEvents(server.port)
  t.after(() => events.close())

  await sleep(1500)
  assert.ok(events.frames.length >= 1, 'ilk kare gelmeli')
  assert.ok(Array.isArray(events.frames[0].music), 'ilk kare kütüphaneyi içermeli')
  assert.ok(events.frames[0].music.length >= 2)
  assert.ok(Array.isArray(events.frames[0].ads), 'reklam listesi de ilk karede olmalı')
})

test('kütüphane değişmediyse tekrar tekrar gönderilmez', async t => {
  const server = await startServer({ music: [makeTone(6, 440), makeTone(6, 660)] })
  t.after(() => server.stop())
  const events = openEvents(server.port)
  t.after(() => events.close())

  await sleep(1000)
  await server.play()
  // Several broadcasts with nothing about the library touched: controls, ticks, track ends.
  for (let i = 0; i < 4; i++) { await server.api('/api/control', 'POST', { action: 'next' }); await sleep(400) }
  await sleep(1000)

  const later = events.frames.slice(1)
  assert.ok(later.length >= 3, `sonraki kareler gelmiş olmalı, gelen: ${later.length}`)
  const repeats = later.filter(frame => frame.music !== undefined)
  assert.equal(repeats.length, 0,
    `kütüphane ${repeats.length} kez gereksiz yeniden gönderildi`)
})

test('kütüphane değişince yeniden gönderilir', async t => {
  // The saving must never cost correctness: a track added or deleted has to reach the panel,
  // or the operator uploads a song and it never appears.
  const server = await startServer({ music: [makeTone(6, 440)] })
  t.after(() => server.stop())
  const events = openEvents(server.port)
  t.after(() => events.close())

  await sleep(1000)
  const before = events.frames.length
  await server.upload('/api/media/music', { filename: 'yeni.mp3', content: fs2.readFileSync(makeTone(6, 880)) })
  await sleep(1500)

  const fresh = events.frames.slice(before).filter(frame => frame.music !== undefined)
  assert.ok(fresh.length >= 1, 'yükleme sonrası kütüphane yeniden gönderilmeli')
  assert.ok(fresh[fresh.length - 1].music.length >= 2, 'yeni parça listede olmalı')
})

test('silme de kütüphaneyi yeniden gönderir', async t => {
  const server = await startServer({ music: [makeTone(6, 440), makeTone(6, 660)] })
  t.after(() => server.stop())
  const events = openEvents(server.port)
  t.after(() => events.close())

  await sleep(1000)
  const list = (await server.state()).music
  const before = events.frames.length
  await server.api(`/api/media/music/${list[0].id}`, 'DELETE')
  await sleep(1500)

  const fresh = events.frames.slice(before).filter(frame => frame.music !== undefined)
  assert.ok(fresh.length >= 1, 'silme sonrası kütüphane yeniden gönderilmeli')
  assert.ok(fresh[fresh.length - 1].music.length === list.length - 1, 'silinen parça listeden düşmeli')
})

test('/api/state her zaman eksiksiz döner', async t => {
  // The one-shot endpoint has no client to remember, and the panel's first paint depends on
  // it. It must never be lean.
  const server = await startServer({ music: [makeTone(6, 440)] })
  t.after(() => server.stop())

  for (let i = 0; i < 3; i++) {
    const state = (await server.api('/api/state')).json
    assert.ok(Array.isArray(state.music) && state.music.length >= 1, `${i + 1}. istek eksiksiz olmalı`)
    assert.ok(Array.isArray(state.ads), 'reklamlar da olmalı')
  }
})
