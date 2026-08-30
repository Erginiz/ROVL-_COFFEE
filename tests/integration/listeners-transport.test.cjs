// Two things the operator reads and acts on constantly: the listener count on the panel, and
// what the transport buttons do. Both are quietly load-bearing.
//
// The count is how a café decides the system is working at all ("nobody is listening" sends
// someone to reboot a station that is fine). The id behind it is chosen by the phone, so it
// is also attacker-controlled — a count that can be inflated, or a map that grows without
// limit, is a real defect and not merely a cosmetic one.

const test = require('node:test')
const assert = require('node:assert')
const { startServer, makeTone, waitFor, sleep, lanIp } = require('../helpers/harness.cjs')

const LAN = lanIp()

test('her telefon bir kez sayılır, aynı telefon tekrar sayılmaz', { timeout: 120000 }, async t => {
  const server = await startServer({ music: [makeTone(10)] })
  t.after(() => server.stop())

  assert.equal((await server.state()).listeners, 0, 'başlangıçta dinleyici olmamalı')

  await server.api('/api/listeners/heartbeat', 'POST', { id: 'telefon-1' })
  await server.api('/api/listeners/heartbeat', 'POST', { id: 'telefon-2' })
  // The same phone beating again must not double-count itself.
  await server.api('/api/listeners/heartbeat', 'POST', { id: 'telefon-1' })

  const state = await waitFor(async () => {
    const s = await server.state()
    return s.listeners >= 2 ? s : null
  }, { timeoutMs: 20000, label: 'dinleyiciler sayıldı' })
  assert.equal(state.listeners, 2, `iki ayrı telefon sayılmalı (okunan: ${state.listeners}）`.replace('）', ')'))
})

test('dinleyici sayısı sınırsız büyütülemez', { timeout: 120000 }, async t => {
  // The id comes from the phone. A loop of fresh ids would otherwise grow the map — and the
  // number on the panel — without limit.
  const server = await startServer({ music: [makeTone(10)] })
  t.after(() => server.stop())

  for (let i = 0; i < 450; i++) {
    await server.api('/api/listeners/heartbeat', 'POST', { id: `sahte-${i}` })
  }
  const state = await server.state()
  assert.ok(state.listeners <= 400, `dinleyici sayısı sınırlanmalı (okunan: ${state.listeners})`)
  assert.ok(state.playback, 'sunucu bu yük altında çalışmaya devam etmeli')
})

test('aşırı uzun dinleyici kimliği kabul edilmez', { timeout: 120000 }, async t => {
  const server = await startServer({ music: [makeTone(10)] })
  t.after(() => server.stop())

  const res = await server.api('/api/listeners/heartbeat', 'POST', { id: 'x'.repeat(5000) })
  assert.equal(res.status, 204, 'istek yine de kabul edilmeli')
  const state = await server.state()
  assert.ok(state.listeners <= 1, 'tek bir kayıt olmalı')
})

test('sonraki/önceki parça çalışır ve geçmiş korunur', { timeout: 180000 }, async t => {
  // "Previous" is the button an operator hits when a customer asks for the last song back.
  const server = await startServer({ music: [makeTone(20, 440), makeTone(20, 660), makeTone(20, 880)] })
  t.after(() => server.stop())

  await server.play()
  const first = await waitFor(async () => (await server.state()).current, { label: 'ilk parça' })

  await server.api('/api/control', 'POST', { action: 'next' })
  const second = await waitFor(async () => {
    const cur = (await server.state()).current
    return cur && cur.id !== first.id ? cur : null
  }, { timeoutMs: 30000, intervalMs: 400, label: 'sonraki parça' })
  assert.notEqual(second.id, first.id, 'sonraki farklı bir parça olmalı')

  await server.api('/api/control', 'POST', { action: 'previous' })
  const back = await waitFor(async () => {
    const cur = (await server.state()).current
    return cur && cur.id === first.id ? cur : null
  }, { timeoutMs: 30000, intervalMs: 400, label: 'önceki parçaya dönüş' })
  assert.equal(back.id, first.id, 'önceki tuşu bir öncekine dönmeli')
})

test('geçmiş boşken önceki tuşu yayını bozmaz', { timeout: 120000 }, async t => {
  // Pressing "previous" as the first thing after launch must not stop the music.
  const server = await startServer({ music: [makeTone(15)] })
  t.after(() => server.stop())
  await server.play()
  await waitFor(async () => (await server.state()).current, { label: 'yayın başladı' })

  const meter = server.listen()
  t.after(() => meter.close())
  await waitFor(() => meter.status === 200, { label: '/live.mp3' })

  await server.api('/api/control', 'POST', { action: 'previous' })
  await server.api('/api/control', 'POST', { action: 'previous' })
  await sleep(1500)

  const state = await server.state()
  assert.ok(state.current, 'bir parça çalıyor olmalı')
  assert.ok((await meter.sample(3000)) > 5000, 'ses akmaya devam etmeli')
})

test('listeden parça seçmek o parçayı çalar', { timeout: 180000 }, async t => {
  const server = await startServer({ music: [makeTone(20, 440), makeTone(20, 660), makeTone(20, 880)] })
  t.after(() => server.stop())
  await server.play()
  const state = await waitFor(async () => {
    const s = await server.state()
    return s.music.length >= 3 ? s : null
  }, { timeoutMs: 30000, label: 'kütüphane hazır' })

  // Pick something that is NOT currently playing.
  const target = state.music.find(m => m.id !== state.playback.currentId)
  await server.api('/api/control', 'POST', { action: 'playTrack', value: target.id })

  const now = await waitFor(async () => {
    const s = await server.state()
    return s.playback.currentId === target.id ? s : null
  }, { timeoutMs: 30000, intervalMs: 400, label: 'seçilen parça çalıyor' })
  assert.equal(now.playback.currentId, target.id, 'seçilen parça yayına girmeli')
  assert.equal(now.playback.status, 'playing', 'seçim yayını başlatmalı')
})

test('duraklat ve devam et konumu korur', { timeout: 180000 }, async t => {
  // Resuming from the top of the track instead of where it paused is the kind of small wrong
  // that the operator notices immediately and cannot explain.
  const server = await startServer({ music: [makeTone(30, 440)] })
  t.after(() => server.stop())
  await server.play()
  await waitFor(async () => (await server.state()).current, { label: 'yayın başladı' })
  await sleep(6000)

  await server.api('/api/control', 'POST', { action: 'pause' })
  const paused = await server.state()
  assert.equal(paused.playback.status, 'paused')
  const frozen = Number(paused.playback.currentOffsetSeconds)
  assert.ok(frozen >= 3, `duraklatınca geçen süre saklanmalı (okunan: ${frozen})`)

  await server.api('/api/control', 'POST', { action: 'play' })
  const resumed = await server.state()
  assert.equal(resumed.playback.status, 'playing', 'devam etmeli')
  const position = Number(resumed.playback.currentOffsetSeconds)
  assert.ok(Math.abs(position - frozen) <= 3, `kaldığı yerden devam etmeli (${frozen} -> ${position})`)
})

test('durdur yayını susturur ama sunucu ayakta kalır', { timeout: 180000 }, async t => {
  const server = await startServer({ music: [makeTone(20)] })
  t.after(() => server.stop())
  await server.play()
  const meter = server.listen()
  t.after(() => meter.close())
  await waitFor(() => meter.status === 200, { label: '/live.mp3' })
  assert.ok((await meter.sample(2500)) > 0, 'önce ses akmalı')

  await server.api('/api/control', 'POST', { action: 'stop' })
  const state = await server.state()
  assert.equal(state.playback.status, 'stopped')

  // The stream itself must stay up — phones stay connected and hear silence, so nothing has
  // to reconnect when the operator presses play again.
  assert.ok(!meter.done, 'durdurmak dinleyicinin bağlantısını kesmemeli')
})
