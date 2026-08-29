// Playback rules the operator relies on but never thinks about: what a button does when
// the thing it needs is missing, and whether an automatic pause always gives the music
// back. Each of these was a real bug — all three end with a café that is silent, or
// playing the wrong thing, for reasons nothing on screen explains.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { startServer, makeTone, waitFor, sleep } = require('../helpers/harness.cjs')

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
