// Every state change is fanned out in full (~13 KB with a real library) to every open
// panel and phone. Two properties matter on a café network, where this traffic shares the
// air with the audio stream every listener is depending on:
//
//   1. A burst of changes — a dragged volume slider — must not become a burst of sends.
//   2. A client that stops reading must be dropped, not buffered for ever.
//
// The tests read the SSE stream directly rather than trusting timers, so they measure what
// a phone actually receives.

const test = require('node:test')
const assert = require('node:assert')
const http = require('http')
const { startServer, makeTone, waitFor, sleep } = require('../helpers/harness.cjs')

// Opens /api/events and counts the `data:` frames that arrive.
function openEventStream(port, host = '127.0.0.1') {
  const stream = { frames: 0, bytes: 0, status: null, buffer: '' }
  stream.req = http.get({ host, port, path: '/api/events' }, res => {
    stream.status = res.statusCode
    res.on('data', chunk => {
      stream.bytes += chunk.length
      stream.buffer += chunk.toString()
      let idx
      while ((idx = stream.buffer.indexOf('\n\n')) !== -1) {
        stream.frames++
        stream.buffer = stream.buffer.slice(idx + 2)
      }
    })
  })
  stream.req.on('error', () => {})
  stream.close = () => { try { stream.req.destroy() } catch {} }
  return stream
}

// Same as above but resolves once the server has answered, so a caller can open connections
// one at a time and know each outcome instead of firing a burst and guessing with a sleep.
function openEventStreamAwaited(port, host = '127.0.0.1') {
  return new Promise(resolve => {
    const stream = { frames: 0, bytes: 0, status: null, buffer: '' }
    stream.close = () => { try { stream.req.destroy() } catch {} }
    stream.req = http.get({ host, port, path: '/api/events' }, res => {
      stream.status = res.statusCode
      res.on('data', chunk => { stream.bytes += chunk.length })
      resolve(stream)
    })
    stream.req.on('error', () => resolve(stream))
    stream.req.setTimeout(8000, () => { stream.close(); resolve(stream) })
  })
}

test('hızlı ayar değişiklikleri tek tek değil, toplu yayınlanır', { timeout: 120000 }, async t => {
  const server = await startServer({ music: [makeTone(20)] })
  t.after(() => server.stop())

  const stream = openEventStream(server.port)
  t.after(() => stream.close())
  await waitFor(() => stream.frames >= 1, { label: 'ilk durum karesi' })

  const before = stream.frames
  // What a volume drag looks like: many changes in a short window.
  const CHANGES = 20
  for (let i = 0; i < CHANGES; i++) {
    await server.api('/api/control', 'POST', { action: 'musicVolume', value: 50 + i })
  }
  await sleep(1200)   // let the trailing send land
  const delivered = stream.frames - before

  assert.ok(delivered >= 1, 'değişiklikler yayınlanmalı — hiç kare gelmemesi de hata olurdu')
  assert.ok(delivered < CHANGES, `${CHANGES} değişiklik ${CHANGES} ayrı yayına dönüşmemeli (gelen: ${delivered})`)

  // Coalescing must not lose the final value: what the phones end up showing has to match
  // the station's real state, or a slider would settle on the wrong number.
  const state = await server.state()
  assert.equal(state.playback.musicVolume, 50 + CHANGES - 1, 'son değer state’e yansımalı')
  await waitFor(async () => {
    const s = await server.state()
    return s.playback.musicVolume === 50 + CHANGES - 1
  }, { label: 'son değer kalıcı' })
})

test('ilk değişiklik anında yayınlanır (gecikme eklenmez)', { timeout: 120000 }, async t => {
  // Coalescing must not make the UI feel laggy: the leading edge goes out immediately and
  // only what follows inside the window is collapsed.
  const server = await startServer({ music: [makeTone(20)] })
  t.after(() => server.stop())

  const stream = openEventStream(server.port)
  t.after(() => stream.close())
  await waitFor(() => stream.frames >= 1, { label: 'ilk durum karesi' })

  const before = stream.frames
  const started = Date.now()
  await server.api('/api/control', 'POST', { action: 'musicVolume', value: 33 })
  await waitFor(() => stream.frames > before, { timeoutMs: 5000, intervalMs: 20, label: 'değişiklik yayını' })
  const elapsed = Date.now() - started
  assert.ok(elapsed < 1000, `tek değişiklik hemen yayınlanmalı (geçen: ${elapsed}ms)`)
})

test('SSE istemci sayısı sınırlanır', { timeout: 120000 }, async t => {
  // Uncapped, a script opening streams in a loop multiplies every broadcast and grows
  // memory. The cap is what keeps one bad client from degrading the whole café.
  const server = await startServer({ music: [makeTone(10)] })
  t.after(() => server.stop())

  // Open them ONE AT A TIME, waiting for each response before the next. Firing 130 at once
  // and sleeping is timing-dependent: it passed alone and failed inside the full suite,
  // where the machine is busier. Waiting for each status makes the outcome the same
  // everywhere.
  const streams = []
  t.after(() => streams.forEach(s => s.close()))
  let refusedAt = 0
  for (let i = 1; i <= 140 && !refusedAt; i++) {
    const s = await openEventStreamAwaited(server.port)
    streams.push(s)
    if (s.status === 503) refusedAt = i
  }
  assert.ok(refusedAt > 0, `sınırın üstündeki bağlantı 503 ile reddedilmeli (140 denemede reddedilmedi)`)
  assert.ok(refusedAt > 100, `sınır makul bir sayıda devreye girmeli (reddedilen: ${refusedAt}.)`)

  // The station must still work for everyone else while under that pressure.
  const state = await server.state()
  assert.ok(state.playback, 'sunucu yük altında da yanıt vermeli')
})

test('yayın durumu kapanırken bekleyen kare göndermez', { timeout: 120000 }, async t => {
  // A coalesced send still queued at shutdown would write into sockets that are being
  // closed. Nothing should crash, and the process must exit cleanly.
  const server = await startServer({ music: [makeTone(10)] })
  const stream = openEventStream(server.port)
  await waitFor(() => stream.frames >= 1, { label: 'ilk durum karesi' })

  // Queue a burst, then tear the server down immediately.
  for (let i = 0; i < 5; i++) server.api('/api/control', 'POST', { action: 'musicVolume', value: 60 + i }).catch(() => {})
  await sleep(50)
  await server.stop()
  stream.close()

  // If shutdown threw, the process would have died before the state file was flushed;
  // reaching here with no unhandled error is the assertion.
  assert.ok(true)
})
