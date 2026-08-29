// Every existing café is running an older build, and their station.json is whatever that
// build wrote. Boot has to survive those files: a missing nested field must fall back to
// its default rather than reaching the engine as `undefined`, which is how a saved state
// from an old version turns into a crash on launch — the one failure an operator cannot
// work around, because the app is dead before they can touch anything.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { startServer, makeTone, waitFor } = require('../helpers/harness.cjs')

// startServer builds the data dir itself, so seed the legacy file by starting once,
// stopping, rewriting station.json, and starting again against the same folder.
async function bootWith(savedState) {
  const seed = await startServer({ music: [makeTone(10)] })
  const dataDir = seed.dataDir
  await seed.proc.kill('SIGKILL')
  await new Promise(r => setTimeout(r, 600))
  fs.writeFileSync(path.join(dataDir, 'station.json'), JSON.stringify(savedState, null, 2))
  // Reuse the seeded folder (music already in place) for the real boot under test.
  const server = await startServer({ music: [], dataDir })
  return server
}

test('eski sürümün station.json’u ile açılış — eksik alanlar varsayılana düşer', { timeout: 120000 }, async t => {
  // A pre-0.2 file: one shared `volume`, no musicVolume/adVolume, no ezan block at all,
  // an adSettings missing half its keys, and leftovers from the removed jingle feature.
  const legacy = {
    station: { name: 'Cafe Radio', port: 8080 },
    playback: { status: 'playing', volume: 55, currentId: null, currentType: null },
    adSettings: { songsEvery: 3 },
    jingles: [{ id: 'x', title: 'eski jingle' }],
    queues: { music: [] },
    music: [], ads: [], history: []
  }
  const server = await bootWith(legacy)
  t.after(() => server.stop())

  const state = await server.state()

  // The nested defaults must be filled in, not left undefined.
  assert.ok(state.playback.musicVolume != null, 'musicVolume varsayılandan gelmeli')
  assert.ok(state.playback.adVolume != null, 'adVolume varsayılandan gelmeli')
  assert.ok(state.adSettings.timedMinutes != null, 'eksik adSettings alanı varsayılana düşmeli')
  assert.equal(state.adSettings.songsEvery, 3, 'kaydedilmiş değer korunmalı')
  assert.ok(state.ezan, 'ezan bloğu hiç yoksa bile oluşturulmalı')
  assert.ok(state.ezan.il, 'ezan varsayılan ili olmalı')
  assert.ok(state.queues, 'queues bloğu olmalı')
  assert.ok('adCursor' in state.queues, 'eksik queues.adCursor varsayılana düşmeli (yoksa reklam seçimi NaN olur)')
})

test('bozuk station.json açılışı engellemez', { timeout: 120000 }, async t => {
  // A half-written file (power cut during a save) must not brick the station: falling back
  // to defaults and playing music beats refusing to start.
  const seed = await startServer({ music: [makeTone(10)] })
  const dataDir = seed.dataDir
  await seed.proc.kill('SIGKILL')
  await new Promise(r => setTimeout(r, 600))
  fs.writeFileSync(path.join(dataDir, 'station.json'), '{ "playback": { "status": "play')

  const server = await startServer({ music: [], dataDir })
  t.after(() => server.stop())

  const state = await server.state()
  assert.ok(state.playback, 'bozuk dosyaya rağmen çalışır durumda olmalı')
  assert.ok(state.playback.musicVolume != null, 'varsayılanlara düşmeli')

  // And the station must still be able to actually broadcast afterwards.
  await server.play()
  const meter = server.listen()
  t.after(() => meter.close())
  await waitFor(() => meter.status === 200, { label: '/live.mp3 after corrupt state' })
  assert.ok((await meter.sample(3000)) > 5000, 'bozuk state sonrası yayın akmalı')
})

test('kütüphanede olmayan parçaya işaret eden kayıt açılışı bozmaz', { timeout: 120000 }, async t => {
  // The operator deleted the song that was on air, from the folder, while the app was off.
  // currentId now points at nothing; the engine must recover instead of dereferencing it.
  const legacy = {
    playback: { status: 'playing', currentId: 'silinmis-parca-id', currentType: 'music', currentOffsetSeconds: 42 },
    queues: { music: ['silinmis-parca-id'], adCursor: 0 },
    music: [], ads: [], history: []
  }
  const server = await bootWith(legacy)
  t.after(() => server.stop())

  // Deliberately no play() call. The saved intent is already "playing", so the station has
  // to sort itself out on its own — an operator who walks in to silence and a UI that says
  // "playing" has no way to know a button press is what it wants.
  const meter = server.listen()
  t.after(() => meter.close())
  await waitFor(() => meter.status === 200, { label: '/live.mp3 with dangling currentId' })

  const onAir = await waitFor(async () => {
    const s = await server.state()
    return s.current && s.current.id !== 'silinmis-parca-id' ? s.current : null
  }, { timeoutMs: 40000, intervalMs: 500, label: 'engine recovers to a real track by itself' })
  assert.ok(onAir.filename, 'kendiliğinden gerçek bir parçaya geçmeli')
  assert.ok((await meter.sample(3000)) > 5000, 'ses akmalı')
})
