// REGRESSION LOCK — 2026-08-28.
//
// The persistent MP3 encoder crashed and the station went silent FOREVER, while looking
// completely healthy from the outside: the process list showed a fresh encoder, the HTTP
// API answered 200, and the log stayed clean. Only the audio was gone.
//
// Cause: pump() sets `pumping = true` and parks on `stdin.once('drain')`. Because ffmpeg's
// `-re` paces the broadcast, that pipe is full almost all the time, so a crash almost
// always lands while the pump is parked. The drain then belonged to a dead process and
// could never fire, `pumping` stayed true forever, and every later pump() call — including
// the one for the respawned encoder — returned at its first line. Measured before the fix:
// 12+ consecutive seconds of ZERO bytes out with a live encoder sitting there unfed.
//
// This test kills the encoder the same way a crash would and insists the broadcast comes
// back. If it ever fails again, the recovery path is broken — do not weaken the assertions.

const test = require('node:test')
const assert = require('node:assert')
const { startServer, makeTone, waitFor, pidAlive } = require('../helpers/harness.cjs')

test('encoder çökmesinden sonra yayın kendini toparlar', { timeout: 120000 }, async t => {
  const server = await startServer({ music: [makeTone(30, 440)] })
  t.after(() => server.stop())

  await server.play()
  const meter = server.listen()
  t.after(() => meter.close())

  await waitFor(() => meter.status === 200, { label: '/live.mp3 connected' })
  const before = await meter.sample(3000)
  assert.ok(before > 5000, `yayın önce akmalı, alınan: ${before} bayt`)

  const encoder = await waitFor(() => server.encoder(), { label: 'encoder process' })
  process.kill(encoder.pid, 'SIGKILL')          // simulate the ffmpeg crash

  // A fresh encoder must appear...
  const revived = await waitFor(() => {
    const e = server.encoder()
    return e && e.pid !== encoder.pid ? e : null
  }, { timeoutMs: 20000, label: 'encoder respawn' })
  assert.ok(!pidAlive(encoder.pid), 'eski encoder gerçekten ölmüş olmalı')

  // ...and — the part that was broken — it must actually be FED. A respawned-but-unfed
  // encoder is precisely the bug, so process liveness alone proves nothing: measure bytes.
  // Two consecutive windows, because the first can be flushed leftovers from before the kill.
  await waitFor(async () => (await meter.sample(2000)) > 0,
    { timeoutMs: 25000, intervalMs: 0, label: 'audio resumes after encoder crash' })
  const window1 = await meter.sample(3000)
  const window2 = await meter.sample(3000)
  assert.ok(window1 > 5000, `kurtarma sonrası 1. pencere akmalı, alınan: ${window1} bayt`)
  assert.ok(window2 > 5000, `kurtarma sonrası 2. pencere akmalı (sürekli akış), alınan: ${window2} bayt`)
  assert.ok(revived.pid, 'yeni encoder çalışıyor olmalı')
})

test('arka arkaya iki encoder çökmesinden sonra da toparlar', { timeout: 120000 }, async t => {
  // The backoff counts restarts within a minute; a second crash must still recover rather
  // than leaving the station silent while it waits.
  const server = await startServer({ music: [makeTone(30, 660)] })
  t.after(() => server.stop())
  await server.play()
  const meter = server.listen()
  t.after(() => meter.close())
  await waitFor(() => meter.status === 200, { label: '/live.mp3 connected' })
  assert.ok((await meter.sample(2500)) > 0, 'yayın başlamalı')

  for (const round of [1, 2]) {
    const enc = await waitFor(() => server.encoder(), { label: `encoder round ${round}` })
    process.kill(enc.pid, 'SIGKILL')
    await waitFor(() => { const e = server.encoder(); return e && e.pid !== enc.pid },
      { timeoutMs: 25000, label: `respawn round ${round}` })
    await waitFor(async () => (await meter.sample(2000)) > 0,
      { timeoutMs: 30000, intervalMs: 0, label: `audio back round ${round}` })
  }
  const finalWindow = await meter.sample(3000)
  assert.ok(finalWindow > 5000, `iki çökme sonrası yayın sürmeli, alınan: ${finalWindow} bayt`)
})
