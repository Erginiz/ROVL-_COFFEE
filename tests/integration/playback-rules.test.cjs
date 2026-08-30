// Playback rules the operator relies on but never thinks about: what a button does when
// the thing it needs is missing, and whether an automatic pause always gives the music
// back. Each of these was a real bug — all three end with a café that is silent, or
// playing the wrong thing, for reasons nothing on screen explains.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { startServer, makeTone, waitFor, sleep } = require('../helpers/harness.cjs')
const { measureBroadcast } = require('../helpers/audio-analysis.cjs')

// Boot a server against a seeded station.json. The first boot is only there to let the
// scanner discover the real files; `build` then receives that scanned state so a test can
// reference genuine track ids, and whatever it returns is what the second boot loads.
async function bootWith(build, { music = [makeTone(20)] } = {}) {
  const seed = await startServer({ music })
  const dataDir = seed.dataDir
  const statePath = path.join(dataDir, 'station.json')
  // Saves are debounced by a second, so the file is not on disk the instant the server is
  // up — wait for a written state that already contains the scanned library, rather than
  // racing it and reading a file that does not exist yet.
  const scanned = await waitFor(() => {
    try {
      const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'))
      return parsed.music?.length ? parsed : null
    } catch { return null }
  }, { timeoutMs: 25000, label: 'station.json written with a scanned library' })
  seed.proc.kill('SIGKILL')
  await sleep(600)
  const merged = { ...scanned, ...build(scanned), music: scanned.music, ads: scanned.ads }
  fs.writeFileSync(path.join(dataDir, 'station.json'), JSON.stringify(merged, null, 2))
  return { server: await startServer({ music: [], dataDir }), scanned }
}

test('ezan penceresinde uygulama yeniden başlarsa müzik yine de geri gelir', { timeout: 120000 }, async t => {
  // The café restarts the app (or Windows reboots it) during a prayer window. The intent to
  // resume used to live in a module variable that the restart wiped, so when the window
  // ended the station simply stayed paused — silent for the rest of the day.
  const twoMinutesAgo = new Date(Date.now() - 2 * 60000)
  const hhmm = `${String(twoMinutesAgo.getHours()).padStart(2, '0')}:${String(twoMinutesAgo.getMinutes()).padStart(2, '0')}`
  const today = new Date()
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`

  const { server } = await bootWith(scanned => ({
    // Persisted mid-ezan: paused by the ezan, on a real track, and — as after a restart —
    // with no memory of what the station was doing before the window began.
    playback: { ...scanned.playback, status: 'paused', currentId: scanned.music[0].id, currentType: 'music', currentOffsetSeconds: 0 },
    ezan: {
      enabled: true, il: 'İstanbul', ilce: '', durationMinutes: 1,
      active: true, activePrayer: 'Öğle', activeUntil: null,
      // prevStatus deliberately absent — this is exactly what a restart leaves behind.
      times: { 'Öğle': hhmm }, timesDate: todayStr, lastError: null
    }
  }))
  t.after(() => server.stop())

  // The window (1 minute, starting two minutes ago) is already over, so the first tick
  // must clear the ezan AND put the music back on.
  const recovered = await waitFor(async () => {
    const s = await server.state()
    return s.ezan.active === false && s.playback.status === 'playing' ? s : null
  }, { timeoutMs: 40000, intervalMs: 500, label: 'ezan clears and music resumes' })
  assert.equal(recovered.ezan.active, false, 'ezan penceresi kapanmalı')
  assert.equal(recovered.playback.status, 'playing', 'ezan bitince müzik geri gelmeli')

  const meter = server.listen()
  t.after(() => meter.close())
  await waitFor(() => meter.status === 200, { label: '/live.mp3' })
  assert.ok((await meter.sample(3000)) > 5000, 'gerçekten ses akmalı')
})

test('ezan sırasında play’e basmak o vakti iptal eder ve müzik susmaz', { timeout: 180000 }, async t => {
  // The operator sometimes needs sound during a prayer window — a private function, an
  // empty café, or simply a wrong time in the fetched schedule. Pressing play used to start
  // the music and then the 20-second tick silently paused it again, which looks like the
  // app fighting them. The override has to hold for the rest of THIS window.
  const now = new Date()
  const startedAMinuteAgo = new Date(now.getTime() - 60000)
  const hhmm = `${String(startedAMinuteAgo.getHours()).padStart(2, '0')}:${String(startedAMinuteAgo.getMinutes()).padStart(2, '0')}`
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`

  const { server } = await bootWith(scanned => ({
    playback: { ...scanned.playback, status: 'playing', currentId: scanned.music[0].id, currentType: 'music' },
    // A window that started a minute ago and runs for 30 more — long enough that the tick
    // would definitely re-pause during this test if the override did not hold.
    ezan: {
      enabled: true, il: 'İstanbul', ilce: '', durationMinutes: 30,
      active: false, activePrayer: null, activeUntil: null, prevStatus: null, overrideUntil: null,
      times: { 'Öğle': hhmm }, timesDate: todayStr, lastError: null
    }
  }), { music: [makeTone(60)] })
  t.after(() => server.stop())

  // The station pauses itself for the prayer, as it should.
  await waitFor(async () => (await server.state()).ezan.active === true,
    { timeoutMs: 40000, intervalMs: 500, label: 'ezan activates' })

  // The operator overrides.
  const res = await server.api('/api/control', 'POST', { action: 'play' })
  assert.equal(res.status, 200)
  const afterPlay = await server.state()
  assert.equal(afterPlay.playback.status, 'playing', 'play müziği başlatmalı')
  assert.equal(afterPlay.ezan.active, false, 'ezan duraklatması iptal edilmeli')

  // Survive more than one tick (20s) — this is the assertion the old behaviour failed.
  const meter = server.listen()
  t.after(() => meter.close())
  await waitFor(() => meter.status === 200, { label: '/live.mp3' })
  await sleep(25000)

  const later = await server.state()
  assert.equal(later.playback.status, 'playing', 'tick müziği tekrar duraklatmamalı')
  assert.equal(later.ezan.active, false, 'ezan penceresi yeniden açılmamalı')
  assert.ok((await meter.sample(3000)) > 5000, 'ses akmaya devam etmeli')
  assert.ok((later.history || []).some(h => /iptal edildi/i.test(h.title)),
    'iptal geçmişte görünmeli — operatör ne olduğunu anlayabilmeli')
})

test('reklam yokken "Şimdi Reklam Çal" çalan şarkıyı değiştirmez', { timeout: 120000 }, async t => {
  // advance({manualAd:true}) finds no ad and falls through to picking MUSIC, so the button
  // silently skipped the song instead of doing nothing.
  const server = await startServer({ music: [makeTone(30, 440), makeTone(30, 660)], ads: [] })
  t.after(() => server.stop())

  await server.play()
  const before = await waitFor(async () => {
    const s = await server.state()
    return s.current ? s.current : null
  }, { timeoutMs: 30000, intervalMs: 500, label: 'a track is on air' })

  const res = await server.api('/api/control', 'POST', { action: 'manualAd' })
  assert.equal(res.status, 200, 'istek yine de başarılı dönmeli')
  await sleep(1500)

  const after = await server.state()
  assert.equal(after.current?.id, before.id, 'reklam yokken çalan parça değişmemeli')
  assert.ok((after.history || []).some(h => /reklam yok/i.test(h.title)),
    'operatör neden bir şey olmadığını geçmişte görebilmeli')
})

test('aşırı büyük seek değeri durumu bozmaz', { timeout: 120000 }, async t => {
  // An unbounded seek produced a date outside Date's range; toISOString() then threw and
  // left a corrupted position behind. The API is authenticated, but an unlocked phone
  // sending a bad value must not be able to poison the station's state.
  const server = await startServer({ music: [makeTone(20)] })
  t.after(() => server.stop())
  await server.play()
  await waitFor(async () => (await server.state()).current, { timeoutMs: 30000, label: 'track on air' })

  for (const value of [1e15, Number.MAX_SAFE_INTEGER, -5, 'abc', null]) {
    const res = await server.api('/api/control', 'POST', { action: 'seek', value })
    assert.ok(res.status < 500, `seek=${value} sunucu hatası vermemeli (dönen: ${res.status})`)
  }

  const state = await server.state()
  const offset = Number(state.playback.currentOffsetSeconds)
  assert.ok(Number.isFinite(offset) && offset >= 0 && offset <= 24 * 3600,
    `konum makul aralıkta kalmalı (okunan: ${offset})`)
  assert.ok(!Number.isNaN(new Date(state.playback.currentStartedAt).getTime()),
    'başlangıç zamanı geçerli bir tarih olmalı')

  // And the station must still be able to play after the abuse.
  const meter = server.listen()
  t.after(() => meter.close())
  await waitFor(() => meter.status === 200, { label: '/live.mp3 after bad seeks' })
  assert.ok((await meter.sample(3000)) > 5000, 'kötü seek sonrası yayın sürmeli')
})

// Shuffle is a switch the operator flips when the room changes — the same eight songs in the
// same order all afternoon is exactly the complaint it exists to answer. But the queue is
// built once and drained; flipping the switch only changed a flag. The panel said "karıştır",
// the next hours played in library order, and nothing on screen explained why.
test('karıştırma açılınca sıradaki şarkılar gerçekten karışır', async t => {
  const server = await startServer({ music: Array.from({ length: 10 }, (_, i) => makeTone(3, 300 + i * 40)) })
  t.after(() => server.stop())

  await server.api('/api/settings', 'PATCH', { playback: { shuffle: false } })
  await server.play()
  await waitFor(async () => ((await server.state()).queues.music.length > 3), { label: 'kuyruk kurulsun' })

  const positions = state => state.queues.music.map(id => state.music.findIndex(track => track.id === id))
  const inOrder = list => list.every((value, index) => index === 0 || value === list[index - 1] + 1)

  const before = positions(await server.state())
  assert.ok(inOrder(before), `hazırlık: kapalıyken sırayla olmalı, gelen: ${before.join(',')}`)

  const changed = await server.api('/api/settings', 'PATCH', { playback: { shuffle: true } })
  assert.equal(changed.status, 200)

  const after = positions(await server.state())
  assert.ok(after.length > 3, 'kuyruk boşaltılıp bırakılmamalı')
  assert.ok(!inOrder(after), `karıştırma açıkken kuyruk hâlâ sırayla: ${after.join(',')}`)
})

test('karıştırma kapatılınca sıraya dönülür', async t => {
  // The reverse is the same lie: a shuffled queue keeps playing at random after the operator
  // has deliberately asked for the library order.
  const server = await startServer({ music: Array.from({ length: 10 }, (_, i) => makeTone(3, 300 + i * 40)) })
  t.after(() => server.stop())

  await server.api('/api/settings', 'PATCH', { playback: { shuffle: true } })
  await server.play()
  await waitFor(async () => ((await server.state()).queues.music.length > 3), { label: 'kuyruk kurulsun' })

  await server.api('/api/settings', 'PATCH', { playback: { shuffle: false } })
  const state = await server.state()
  const positions = state.queues.music.map(id => state.music.findIndex(track => track.id === id))
  const ascending = positions.every((value, index) => index === 0 || value > positions[index - 1])
  assert.ok(ascending, `kapatınca kütüphane sırasına dönmeli, gelen: ${positions.join(',')}`)
})

test('karıştırma değişimi çalan şarkıyı kesmez', async t => {
  // Rebuilding the queue must not touch what is coming out of the speakers right now —
  // an audible jump every time a switch is flipped would be a worse bug than the one fixed.
  const server = await startServer({ music: Array.from({ length: 8 }, (_, i) => makeTone(6, 300 + i * 40)) })
  t.after(() => server.stop())

  await server.play()
  await waitFor(async () => Boolean((await server.state()).playback.currentId), { label: 'çalmaya başlasın' })
  const playing = (await server.state()).playback.currentId

  await server.api('/api/settings', 'PATCH', { playback: { shuffle: true } })
  await sleep(500)

  const state = await server.state()
  assert.equal(state.playback.currentId, playing, 'çalan parça değişmemeli')
  assert.equal(state.playback.status, 'playing')
  assert.ok(!state.queues.music.includes(playing), 'çalan parça hemen tekrar kuyruğa girmemeli')
})

// The very first thing anyone does with a fresh install is press Play. With no music in the
// folder yet, the button answered 200, the station stayed stopped, the history stayed empty
// and the status card stayed green — the operator is left pressing a button that reports
// success and does nothing, with no idea that the folder is what is missing.
test('boş kütüphanede çalma denemesi sebebiyle birlikte bildirilir', async t => {
  const server = await startServer({ music: [] })
  t.after(() => server.stop())

  const response = await server.api('/api/control', 'POST', { action: 'play' })
  assert.equal(response.status, 200, 'istek hata döndürmemeli — bu bir kullanıcı hatası değil')
  await sleep(1500)

  const state = await server.state()
  assert.equal(state.playback.status, 'stopped', 'çalacak bir şey yokken çalıyor görünmemeli')
  const told = (state.history || []).some(entry => /müzik|parça|klasör/i.test(entry.title || ''))
  assert.ok(told, `sebep günlüğe yazılmalı, gelen: ${JSON.stringify((state.history || []).slice(0, 3))}`)
})

test('aynı sebep tekrar tekrar günlüğe yazılmaz', async t => {
  // An operator who does not understand why will press it again. Five presses must not cost
  // five identical lines in a log that only holds a hundred.
  const server = await startServer({ music: [] })
  t.after(() => server.stop())

  for (let i = 0; i < 5; i++) { await server.api('/api/control', 'POST', { action: 'play' }); await sleep(300) }
  await sleep(1000)

  const notices = (await server.state()).history.filter(entry => /müzik|parça|klasör/i.test(entry.title || ''))
  assert.ok(notices.length <= 2, `${notices.length} kez yazılmış — günlüğü dolduruyor`)
})

test('müzik eklenince çalma yeniden denenebilir', async t => {
  // The notice must not latch: once the folder has music, pressing Play has to work, and the
  // next empty-library episode has to be reported again.
  const server = await startServer({ music: [] })
  t.after(() => server.stop())

  await server.api('/api/control', 'POST', { action: 'play' })
  await sleep(800)

  const source = makeTone(6, 440)
  fs.copyFileSync(source, path.join(server.dataDir, 'Music', 'sonradan.mp3'))
  await server.api('/api/rescan', 'POST')
  await server.api('/api/control', 'POST', { action: 'play' })

  await waitFor(async () => (await server.state()).playback.status === 'playing',
    { timeoutMs: 15000, label: 'müzik eklenince çalmalı' })

  // And the notice must re-arm. If the library empties again — a folder on a drive that
  // dropped off, or files moved out — the operator has to be told a second time, not left
  // with a station that goes quiet having already "said it once" hours ago.
  // `klasör[üu]?`, not `klasör boş`: the message reads "Müzik klasörü boş", and Turkish
  // suffixes sit between the words a naive pattern expects to be adjacent. The same trap
  // (`yedek` vs `yedeği`) already cost one debugging round in this suite.
  const countNotices = async () =>
    (await server.state()).history.filter(entry => /klasör[üu]? boş|bulunamadı/i.test(entry.title || '')).length
  const before = await countNotices()

  fs.rmSync(path.join(server.dataDir, 'Music', 'sonradan.mp3'), { force: true })
  await server.api('/api/rescan', 'POST')
  await server.api('/api/control', 'POST', { action: 'play' })
  await sleep(1500)

  assert.ok(await countNotices() > before, 'kütüphane yeniden boşalınca tekrar bildirilmeli')
})

// The whole ezan feature, measured where the café actually experiences it: in the sound.
// Everything about it has been tested through `ezan.active` and `playback.status` until now —
// and "the state says playing" is precisely the lie this project keeps uncovering. A pause
// that leaves the speakers running, or a window that ends with the music never coming back,
// would pass every existing ezan test.
test('ezan vaktinde ses gerçekten susar ve sonra gerçekten geri gelir', { timeout: 300000 }, async t => {
  const now = new Date()
  // A window that opens in a few seconds and lasts one minute — the shortest the station
  // accepts, so the test lives through a complete cycle rather than half of one.
  const soon = new Date(now.getTime() + 8000)
  const hhmm = `${String(soon.getHours()).padStart(2, '0')}:${String(soon.getMinutes()).padStart(2, '0')}`
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`

  const { server } = await bootWith(scanned => ({
    playback: { ...scanned.playback, status: 'playing', currentId: scanned.music[0].id, currentType: 'music' },
    ezan: {
      enabled: true, il: 'İstanbul', ilce: '', durationMinutes: 1,
      active: false, activePrayer: null, activeUntil: null, prevStatus: null, overrideUntil: null,
      times: { 'Öğle': hhmm }, timesDate: todayStr, lastError: null
    }
  }), { music: [makeTone(240)] })
  t.after(() => server.stop())

  const meter = server.listen()
  t.after(() => meter.close())
  await waitFor(() => meter.status === 200, { label: '/live.mp3 bağlansın' })

  // 1. Music is on the air to begin with.
  assert.ok((await meter.sample(3000)) > 20000, 'hazırlık: önce müzik akmalı')

  // 2. The prayer window opens and the café goes quiet. The stream itself must not end —
  //    the server keeps sending silence on the same connection, which is what lets a phone
  //    resume on its own afterwards instead of needing to reconnect.
  await waitFor(async () => (await server.state()).ezan.active === true,
    { timeoutMs: 60000, intervalMs: 500, label: 'ezan başlasın' })
  const duringBytes = await meter.sample(4000)
  assert.ok(duringBytes > 0, 'yayın kesilmemeli — sessizlik gönderilmeli, bağlantı kopmamalı')
  assert.ok(meter.status === 200, 'bağlantı ayakta kalmalı')
  // Bytes are NOT sound: the encoder keeps producing MP3 frames of pure silence, so a
  // byte count says the connection is alive and nothing at all about what the café hears.
  // Measuring the level is the only way this test can tell a paused station from a broken
  // one — checked by mutation, and the byte-count version did not notice.
  const quiet = await measureBroadcast(server.port, 4)
  assert.ok(quiet.rms < 0.02, `ezan sırasında sessiz olmalı, seviye: ${quiet.rms.toFixed(4)}`)

  // 3. The window closes and the music comes back — in the audio, not in a flag.
  await waitFor(async () => (await server.state()).ezan.active === false,
    { timeoutMs: 120000, intervalMs: 1000, label: 'ezan bitsin' })
  const loud = await waitFor(async () => {
    const measured = await measureBroadcast(server.port, 4)
    return measured.rms > 0.05 ? measured : null
  }, { timeoutMs: 60000, intervalMs: 0, label: 'müzik geri gelsin' })

  assert.ok(loud.rms > 0.05, `ezandan sonra müzik DUYULMALI, seviye: ${loud.rms.toFixed(4)}`)
  assert.equal((await server.state()).playback.status, 'playing')
})
