// An orphaned ffmpeg is the failure this project has actually lived through: an encoder
// that outlived its parent kept a real café's audio device and CPU busy for 40+ minutes,
// invisible in every UI. Windows does not kill a child when the parent dies, so nothing
// but our own teardown (and ffmpeg noticing its pipes closed) prevents it.
//
// The abrupt-kill case is deliberate: Task Manager, a crash, or a forced app close is
// exactly when cleanup is most likely to be skipped.

const test = require('node:test')
const assert = require('node:assert')
const { startServer, makeTone, waitFor, sleep, pidAlive, killPid } = require('../helpers/harness.cjs')

test('sunucu aniden öldürülünce arkada ffmpeg kalmaz', { timeout: 120000 }, async t => {
  const server = await startServer({ music: [makeTone(30, 520)] })
  let leaked = []
  t.after(async () => { for (const p of leaked) if (pidAlive(p.pid)) killPid(p.pid); await server.stop() })

  await server.play()
  const meter = server.listen()
  await waitFor(() => meter.status === 200, { label: '/live.mp3 connected' })
  assert.ok((await meter.sample(2500)) > 0, 'test anlamlı olsun diye yayın akıyor olmalı')

  // Both children should exist by now: the persistent encoder and the track decoder.
  const children = await waitFor(() => {
    const c = server.children()
    return c.length >= 2 ? c : null
  }, { label: 'encoder + decoder running' })
  leaked = children
  meter.close()

  process.kill(server.pid, 'SIGKILL')            // no graceful shutdown runs
  await waitFor(() => !pidAlive(server.pid), { label: 'server process gone' })

  // ffmpeg should notice its stdio pipes closed and exit on its own. Give it a real
  // grace period — this asserts "no orphan a minute later", not "instant".
  await waitFor(() => children.every(c => !pidAlive(c.pid)),
    { timeoutMs: 30000, intervalMs: 500, label: 'ffmpeg children exit with the server' })

  const survivors = children.filter(c => pidAlive(c.pid))
  assert.deepEqual(survivors.map(s => s.pid), [], 'hiçbir ffmpeg süreci hayatta kalmamalı')
  leaked = []
})

test('mikrofon kapatılınca resampler süreci kalmaz', { timeout: 120000 }, async t => {
  const server = await startServer({ music: [makeTone(30, 300)] })
  t.after(() => server.stop())
  await server.play()

  const before = server.children().length
  await server.api('/api/control', 'POST', { action: 'microphoneStart', value: 48000 })
  // The bridge starts on the first chunk, not on the control call.
  await server.api('/api/mic/chunk', 'POST', null, { 'Content-Type': 'application/octet-stream' })
    .catch(() => {})
  const withMic = await waitFor(() => {
    const n = server.children().length
    return n > before ? n : null
  }, { timeoutMs: 10000, label: 'mic resampler spawned' }).catch(() => null)

  await server.api('/api/control', 'POST', { action: 'microphoneStop' })
  await sleep(2000)
  if (withMic) {
    await waitFor(() => server.children().length <= before,
      { timeoutMs: 15000, label: 'mic resampler reaped' })
  }
  assert.ok(server.children().length <= before,
    `mikrofon durunca süreç sayısı başlangıca dönmeli (başlangıç ${before}, şimdi ${server.children().length})`)
})
