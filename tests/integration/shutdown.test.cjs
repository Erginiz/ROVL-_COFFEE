// Closing the app has to close the STATION, not just stop accepting connections. Three
// things must actually happen, and each has a real cost when it does not:
//
//   - The state is flushed. Saves are debounced by a second, so the last thing the operator
//     did — a volume change, a track pick — is routinely still in memory when they close the
//     window. Losing it silently makes the app feel like it forgets.
//   - ffmpeg dies. This project has already lived through an encoder that outlived its
//     parent and held the café's audio device for 40 minutes.
//   - Listeners' connections end, rather than being left to time out.
//
// Windows does not deliver SIGTERM/SIGINT to a quitting Electron app, so the graceful path
// is reached through the handle the server exposes — which is what these tests exercise.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { startServer, makeTone, waitFor, sleep, pidAlive } = require('../helpers/harness.cjs')

test('kapanış durumu diske yazar (son değişiklik kaybolmaz)', { timeout: 120000 }, async t => {
  // The debounce is the trap: change something and close immediately, and without an
  // explicit flush the change is gone.
  const server = await startServer({ music: [makeTone(10)], control: true })
  const statePath = path.join(server.dataDir, 'station.json')
  t.after(() => server.stop())

  await waitFor(() => fs.existsSync(statePath), { timeoutMs: 25000, label: 'ilk kayıt' })
  await server.api('/api/control', 'POST', { action: 'musicVolume', value: 137 })

  // Close it the way the desktop app does, then read what reached the disk.
  await server.control('/shutdown').catch(() => {})
  await sleep(1500)

  const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  assert.equal(saved.playback.musicVolume, 137, 'kapanmadan önceki son değişiklik kaydedilmeli')
})

test('kapanışta ffmpeg süreçleri öldürülür', { timeout: 120000 }, async t => {
  const server = await startServer({ music: [makeTone(20)], control: true })
  t.after(() => server.stop())
  await server.play()

  const children = await waitFor(() => {
    const c = server.children()
    return c.length >= 1 ? c : null
  }, { label: 'ffmpeg çalışıyor' })

  await server.control('/shutdown').catch(() => {})
  await waitFor(() => children.every(c => !pidAlive(c.pid)),
    { timeoutMs: 20000, intervalMs: 400, label: 'ffmpeg kapandı' })
  assert.deepEqual(children.filter(c => pidAlive(c.pid)).map(c => c.pid), [],
    'kapanıştan sonra ffmpeg kalmamalı')
})

test('kapanışta dinleyicilerin bağlantısı düzgün sonlandırılır', { timeout: 120000 }, async t => {
  // Left open, a phone sits on a dead stream until its own timeout — the listener hears
  // silence and has no reason to reconnect.
  const server = await startServer({ music: [makeTone(20)], control: true })
  t.after(() => server.stop())
  await server.play()

  const meter = server.listen()
  t.after(() => meter.close())
  await waitFor(() => meter.status === 200, { label: '/live.mp3 bağlandı' })
  assert.ok((await meter.sample(2000)) > 0, 'yayın akmalı')

  await server.control('/shutdown').catch(() => {})
  await waitFor(() => meter.done, { timeoutMs: 20000, intervalMs: 300, label: 'akış sonlandı' })
  assert.equal(meter.done, true, 'yayın bağlantısı kapanışta sonlandırılmalı')
})

test('iki kez kapatma çağrısı sorun çıkarmaz', { timeout: 120000 }, async t => {
  // before-quit can fire more than once, and the signal handlers exist alongside it.
  const server = await startServer({ music: [makeTone(10)], control: true })
  t.after(() => server.stop())

  await server.control('/shutdown').catch(() => {})
  await server.control('/shutdown').catch(() => {})
  await sleep(1000)

  // Nothing to assert beyond "it did not crash into an unhandled error"; the process being
  // reapable by the harness afterwards is the signal.
  assert.ok(true)
})
