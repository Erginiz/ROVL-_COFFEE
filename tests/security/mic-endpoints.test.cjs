// The announcement path is the one place where a silent failure is worst: the browser grants
// the microphone, the panel looks live, and the operator talks to a café that hears nothing.
// The phone client now reacts to these exact status codes — refusing an expired session and
// telling the operator — so the codes themselves are a contract worth pinning.
//
// It is also the only endpoint that accepts a stream of raw bytes from the network, so what
// it does when it is NOT expecting audio matters.

const test = require('node:test')
const assert = require('node:assert')
const { startServer, makeTone, lanIp } = require('../helpers/harness.cjs')

const LAN = lanIp()
const skip = LAN ? false : 'bu makinede LAN adresi yok'

test('mikrofon uçları giriş yapmamış telefona kapalı', { skip, timeout: 120000 }, async t => {
  const server = await startServer({ music: [makeTone(10)] })
  t.after(() => server.stop())

  const start = await server.api('/api/control', 'POST', { action: 'microphoneStart', value: 48000 }, {}, LAN)
  assert.equal(start.status, 403, 'tokensiz mikrofon başlatılamamalı')

  const chunk = await server.raw('/api/mic/chunk', 'POST', Buffer.alloc(320),
    { 'Content-Type': 'application/octet-stream' }, LAN)
  assert.equal(chunk.status, 403, 'tokensiz ses parçası kabul edilmemeli')

  const end = await server.api('/api/mic/end', 'POST', null, {}, LAN)
  assert.equal(end.status, 403, 'tokensiz anons sonlandırma kabul edilmemeli')
})

test('mikrofon açık değilken gelen ses reddedilir (409)', { timeout: 120000 }, async t => {
  // The client uses this to notice an announcement the server has already ended — without
  // it, a phone would keep posting audio into a station that stopped listening.
  const server = await startServer({ music: [makeTone(10)] })
  t.after(() => server.stop())

  const chunk = await server.raw('/api/mic/chunk', 'POST', Buffer.alloc(320),
    { 'Content-Type': 'application/octet-stream' })
  assert.equal(chunk.status, 409, 'anons başlatılmadan ses gönderilememeli')
})

test('anons başlatıldıktan sonra ses kabul edilir ve durdurulabilir', { timeout: 120000 }, async t => {
  // The happy path, so the guards above cannot be "fixed" by simply refusing everything.
  const server = await startServer({ music: [makeTone(10)] })
  t.after(() => server.stop())

  const start = await server.api('/api/control', 'POST', { action: 'microphoneStart', value: 48000 })
  assert.equal(start.status, 200)

  // s16le silence — real PCM shaped the way the browser sends it.
  const sent = await server.raw('/api/mic/chunk', 'POST', Buffer.alloc(3840),
    { 'Content-Type': 'application/octet-stream' })
  assert.equal(sent.status, 204, 'anons açıkken ses kabul edilmeli')

  const stop = await server.api('/api/control', 'POST', { action: 'microphoneStop' })
  assert.equal(stop.status, 200)

  // And after stopping, the server must go back to refusing audio.
  const after = await server.raw('/api/mic/chunk', 'POST', Buffer.alloc(320),
    { 'Content-Type': 'application/octet-stream' })
  assert.equal(after.status, 409, 'anons bitince ses tekrar reddedilmeli')
})

test('aşırı büyük ses parçası reddedilir', { timeout: 120000 }, async t => {
  // The endpoint reads raw bytes off the network; without a cap one request could hand the
  // station an arbitrarily large buffer.
  const server = await startServer({ music: [makeTone(10)] })
  t.after(() => server.stop())
  await server.api('/api/control', 'POST', { action: 'microphoneStart', value: 48000 })

  const huge = await server.raw('/api/mic/chunk', 'POST', Buffer.alloc(4 * 1024 * 1024),
    { 'Content-Type': 'application/octet-stream' })
  assert.ok(huge.status >= 400, `4MB parça reddedilmeli (dönen: ${huge.status})`)

  // The station must still be healthy afterwards.
  const state = await server.state()
  assert.ok(state.playback, 'sunucu ayakta kalmalı')
})
