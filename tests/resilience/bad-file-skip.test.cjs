// A café's music folder is not a curated dataset: half-copied downloads, files on a
// network share that goes away, the odd renamed .txt. The station must step over those
// without the broadcast going quiet — a silent café is the failure the operator notices,
// and the one they cannot diagnose.
//
// Two engine paths cover this and both are tested here:
//   1. the decoder exits non-zero having produced nothing  → onTrackFailed, skip now
//   2. the decoder hangs producing nothing at all          → checkStall(), skip after 8s
// Path 2 is the watchdog; without it a single bad file froze the whole broadcast.

const test = require('node:test')
const assert = require('node:assert')
const { startServer, makeTone, waitFor } = require('../helpers/harness.cjs')

test('bozuk dosya yayını dondurmaz, sağlam parçaya geçilir', { timeout: 120000 }, async t => {
  // One unreadable file plus one good one. Whichever is picked first, the station must
  // end up playing the good track with audio flowing.
  const server = await startServer({ music: [makeTone(30, 440)], corruptMusic: 1 })
  t.after(() => server.stop())

  // Wait for the scan to settle instead of reading straight away: the boot scan and an
  // explicit /api/rescan share a `scanning` guard, so a rescan that arrives mid-pass is a
  // no-op and the state it returns can still be missing files.
  const settled = await waitFor(async () => {
    const s = await server.state()
    return s.music.some(m => /^track-/.test(m.filename)) ? s : null
  }, { timeoutMs: 30000, label: 'library scan settles' })
  assert.ok(settled.music.length >= 1, 'sağlam parça kütüphanede olmalı')

  await server.play()
  const meter = server.listen()
  t.after(() => meter.close())
  await waitFor(() => meter.status === 200, { label: '/live.mp3 connected' })

  // The engine must settle on the playable file rather than looping on the broken one.
  const onAir = await waitFor(async () => {
    const s = await server.state()
    const cur = s.current
    return cur && /^track-/.test(cur.filename) ? cur : null
  }, { timeoutMs: 40000, intervalMs: 500, label: 'engine lands on the playable track' })
  assert.match(onAir.filename, /^track-/, 'yayında sağlam parça olmalı')

  const flowing = await meter.sample(3000)
  assert.ok(flowing > 5000, `bozuk dosyaya rağmen ses akmalı, alınan: ${flowing} bayt`)
})

test('kütüphanenin tamamı bozuksa sunucu ayakta kalır ve sonsuz döngüye girmez', { timeout: 120000 }, async t => {
  // Nothing is playable. The engine is allowed to give up on playback, but it must not
  // spin, crash, or take the HTTP server down with it — the operator still needs the UI
  // to see what happened and fix the folder.
  const server = await startServer({ music: [], corruptMusic: 2 })
  t.after(() => server.stop())

  await server.play()
  await new Promise(r => setTimeout(r, 12000))

  const state = await server.state()
  assert.ok(state, 'API hâlâ yanıt vermeli')
  assert.notEqual(state.playback.status, undefined, 'oynatma durumu okunabilir olmalı')

  // The stream endpoint must still serve (silence is fine) rather than erroring out.
  const meter = server.listen()
  t.after(() => meter.close())
  await waitFor(() => meter.status === 200, { timeoutMs: 15000, label: '/live.mp3 still served' })
  assert.equal(meter.status, 200, 'çalınabilir dosya olmasa da yayın ucu açık kalmalı')

  // And the failure has to be visible to the operator, not swallowed.
  const sawFailure = (state.history || []).some(h => h.type === 'system')
  assert.ok(sawFailure, 'geçmişte bir sistem kaydı olmalı (operatör sebebi görebilmeli)')
})
