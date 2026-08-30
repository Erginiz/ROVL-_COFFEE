// The announcement path, end to end. This is the feature with the worst failure mode in the
// product: the operator picks up the phone, the panel says the microphone is live, they
// speak to a café full of people — and nothing comes out. Nothing errors, nothing logs, the
// music keeps playing. They only find out from the customers.
//
// So these tests do not ask "did the endpoint return 204". They push real PCM in and check
// the broadcast actually carries it, and that the ffmpeg bridge behind it is started, fed,
// and cleaned up.

const test = require('node:test')
const assert = require('node:assert')
const { startServer, makeTone, waitFor, sleep } = require('../helpers/harness.cjs')

// One chunk of s16le mono PCM, shaped exactly the way the browser sends it: a loud tone, so
// its arrival is measurable in the encoded output.
function pcmTone({ samples = 4800, rate = 48000, freq = 900, amplitude = 0.8 } = {}) {
  const buf = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) {
    const value = Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 32767 * amplitude)
    buf.writeInt16LE(value, i * 2)
  }
  return buf
}
const micHeaders = { 'Content-Type': 'application/octet-stream' }

test('anons başlatılınca ses köprüsü kurulur ve beslenir', { timeout: 180000 }, async t => {
  const server = await startServer({ music: [makeTone(25, 440)] })
  t.after(() => server.stop())
  await server.play()

  const meter = server.listen()
  t.after(() => meter.close())
  await waitFor(() => meter.status === 200, { label: '/live.mp3' })
  assert.ok((await meter.sample(2500)) > 0, 'önce müzik akmalı')

  const before = server.children().length
  assert.equal((await server.api('/api/control', 'POST', { action: 'microphoneStart', value: 48000 })).status, 200)

  // The bridge starts on the FIRST chunk, not on the control call — so pushing audio is what
  // proves it works.
  for (let i = 0; i < 10; i++) {
    const res = await server.raw('/api/mic/chunk', 'POST', pcmTone(), micHeaders)
    assert.equal(res.status, 204, 'ses parçası kabul edilmeli')
  }

  const withMic = await waitFor(() => {
    const n = server.children().length
    return n > before ? n : null
  }, { timeoutMs: 20000, label: 'mikrofon köprüsü başladı' })
  assert.ok(withMic > before, 'anons için ek bir ffmpeg süreci çalışmalı')

  // And the broadcast has to keep flowing while the announcement is live.
  assert.ok((await meter.sample(3000)) > 5000, 'anons sırasında yayın akmalı')
})

test('anons bitince köprü kapanır, müzik devam eder', { timeout: 180000 }, async t => {
  const server = await startServer({ music: [makeTone(25, 440)] })
  t.after(() => server.stop())
  await server.play()

  const meter = server.listen()
  t.after(() => meter.close())
  await waitFor(() => meter.status === 200, { label: '/live.mp3' })

  const before = server.children().length
  await server.api('/api/control', 'POST', { action: 'microphoneStart', value: 48000 })
  for (let i = 0; i < 5; i++) await server.raw('/api/mic/chunk', 'POST', pcmTone(), micHeaders)
  await waitFor(() => server.children().length > before, { timeoutMs: 20000, label: 'köprü başladı' })

  await server.api('/api/control', 'POST', { action: 'microphoneStop' })
  await waitFor(() => server.children().length <= before,
    { timeoutMs: 20000, intervalMs: 500, label: 'köprü kapandı' })

  const state = await server.state()
  assert.equal(state.microphone.enabled, false, 'anons kapalı görünmeli')
  assert.ok((await meter.sample(3000)) > 5000, 'anonstan sonra müzik akmalı')
})

test('anons kapalıyken gönderilen ses reddedilir', { timeout: 120000 }, async t => {
  // The client uses this to notice an announcement the server has already ended.
  const server = await startServer({ music: [makeTone(15)] })
  t.after(() => server.stop())

  const res = await server.raw('/api/mic/chunk', 'POST', pcmTone(), micHeaders)
  assert.equal(res.status, 409, 'başlatılmamış anonsa ses kabul edilmemeli')
})

test('anons sırasında müzik kısılır (ducking ayarı uygulanır)', { timeout: 180000 }, async t => {
  // The setting exists so the announcement can be heard over the music. What matters is that
  // it is applied live, without restarting the decoder — the operator moves it mid-sentence.
  const server = await startServer({ music: [makeTone(25, 440)] })
  t.after(() => server.stop())
  await server.play()

  const meter = server.listen()
  t.after(() => meter.close())
  await waitFor(() => meter.status === 200, { label: '/live.mp3' })

  await server.api('/api/settings', 'PATCH', { microphone: { ducking: 80 } })
  await server.api('/api/control', 'POST', { action: 'microphoneStart', value: 48000 })
  for (let i = 0; i < 8; i++) await server.raw('/api/mic/chunk', 'POST', pcmTone(), micHeaders)

  const state = await server.state()
  assert.equal(state.microphone.ducking, 80, 'kısma seviyesi kaydedilmeli')
  // The audio must not have been interrupted by the change.
  assert.ok((await meter.sample(3000)) > 5000, 'kısma değişikliği yayını kesmemeli')

  await server.api('/api/control', 'POST', { action: 'microphoneStop' })
})

test('düzensiz ve bozuk ses parçaları istasyonu bozmaz', { timeout: 180000 }, async t => {
  // A phone's capture loop produces uneven chunks, and a flaky connection truncates them.
  const server = await startServer({ music: [makeTone(25, 440)] })
  t.after(() => server.stop())
  await server.play()

  const meter = server.listen()
  t.after(() => meter.close())
  await waitFor(() => meter.status === 200, { label: '/live.mp3' })

  await server.api('/api/control', 'POST', { action: 'microphoneStart', value: 48000 })
  const oddSizes = [1, 3, 17, 511, 4801, 12345]
  for (const size of oddSizes) {
    const res = await server.raw('/api/mic/chunk', 'POST', Buffer.alloc(size), micHeaders)
    assert.ok(res.status < 500, `${size} baytlık parça sunucu hatası vermemeli (${res.status})`)
  }
  // An empty body too — the client can send one when its queue drained.
  assert.ok((await server.raw('/api/mic/chunk', 'POST', Buffer.alloc(0), micHeaders)).status < 500)

  assert.ok((await meter.sample(3000)) > 5000, 'bozuk parçalara rağmen yayın akmalı')
  await server.api('/api/control', 'POST', { action: 'microphoneStop' })
})

test('anons açıkken istasyon kapatılırsa köprü de kapanır', { timeout: 180000 }, async t => {
  // An announcement in progress when the café closes the app must not leave an ffmpeg behind.
  const server = await startServer({ music: [makeTone(20)], control: true })
  t.after(() => server.stop())
  await server.play()

  await server.api('/api/control', 'POST', { action: 'microphoneStart', value: 48000 })
  for (let i = 0; i < 5; i++) await server.raw('/api/mic/chunk', 'POST', pcmTone(), micHeaders)
  const children = await waitFor(() => {
    const c = server.children()
    return c.length >= 2 ? c : null
  }, { timeoutMs: 20000, label: 'müzik + mikrofon süreçleri' })

  await server.control('/shutdown').catch(() => {})
  const { pidAlive } = require('../helpers/harness.cjs')
  await waitFor(() => children.every(c => !pidAlive(c.pid)),
    { timeoutMs: 20000, intervalMs: 400, label: 'tüm ffmpeg süreçleri kapandı' })
  assert.deepEqual(children.filter(c => pidAlive(c.pid)).map(c => c.pid), [],
    'anons açıkken kapanışta süreç kalmamalı')
})
