// "Her N şarkıda bir reklam" is what the café is actually paying for — an ad that never
// plays is lost revenue nobody notices, and one that plays too often drives customers out.
// The counter that decides this is nudged from several places (track end, manual ad, the
// settings screen), so it is worth pinning down end to end rather than trusting the arithmetic.
//
// Short tones keep the test honest: tracks really do start and finish, so the counter is
// driven by the engine the way it is in the café.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { startServer, makeTone, waitFor, sleep } = require('../helpers/harness.cjs')
const { measureBroadcast } = require('../helpers/audio-analysis.cjs')

// Watches what goes on air and records the sequence of types (music/ad).
async function recordAirplay(server, seconds) {
  const seen = []
  const deadline = Date.now() + seconds * 1000
  let last = null
  while (Date.now() < deadline) {
    const s = await server.state().catch(() => null)
    const cur = s?.current
    if (cur && cur.id !== last) {
      last = cur.id
      seen.push({ type: s.playback.currentType, title: cur.title, file: cur.filename })
    }
    await sleep(500)
  }
  return seen
}

test('her N şarkıda bir reklam gerçekten çalar', { timeout: 240000 }, async t => {
  // Two songs, then an ad. Short files so several rotations happen inside the test.
  const server = await startServer({
    music: [makeTone(4, 440), makeTone(4, 660), makeTone(4, 880)],
    ads: [makeTone(3, 300)]
  })
  t.after(() => server.stop())

  await server.api('/api/settings', 'PATCH', { adSettings: { songsEnabled: true, timedEnabled: false, songsEvery: 2 } })
  await server.play()

  const air = await recordAirplay(server, 60)
  const ads = air.filter(x => x.type === 'ad')
  const music = air.filter(x => x.type === 'music')

  assert.ok(music.length >= 2, `müzik çalmalı (görülen: ${air.map(a => a.type).join(',')})`)
  assert.ok(ads.length >= 1, `reklam en az bir kez çalmalı (görülen: ${air.map(a => a.type).join(',')})`)
  // And it must not take over: with "every 2 songs" the ads cannot outnumber the music.
  assert.ok(ads.length <= music.length, `reklam müzikten fazla olmamalı (müzik ${music.length}, reklam ${ads.length})`)
})

test('reklam otomasyonu kapalıyken reklam çalmaz', { timeout: 180000 }, async t => {
  // The café that switched ads off must get silence from the ad folder, not "occasionally".
  const server = await startServer({
    music: [makeTone(4, 440), makeTone(4, 660)],
    ads: [makeTone(3, 300)]
  })
  t.after(() => server.stop())

  await server.api('/api/settings', 'PATCH', { adSettings: { songsEnabled: false, timedEnabled: false } })
  await server.play()

  const air = await recordAirplay(server, 40)
  assert.equal(air.filter(x => x.type === 'ad').length, 0,
    `kapalıyken reklam çalmamalı (görülen: ${air.map(a => a.type).join(',')})`)
  assert.ok(air.length >= 2, 'müzik dönmeye devam etmeli')
})

test('zamanlı reklam vakti gelince çalar', { timeout: 300000 }, async t => {
  // The real clock, at the shortest interval the settings allow. Seeding an already-due time
  // into station.json does NOT work — and that is correct behaviour, not a bug: the schedule
  // is reset at boot, so an ad that came due while the café was closed is skipped rather than
  // fired the moment the doors open.
  const server = await startServer({
    music: [makeTone(4, 440), makeTone(4, 660)],
    ads: [makeTone(3, 300)]
  })
  t.after(() => server.stop())

  // Songs rule off, so anything that plays is the TIMED rule and nothing else.
  await server.api('/api/settings', 'PATCH', {
    adSettings: { songsEnabled: false, timedEnabled: true, timedMinutes: 1 }
  })
  await server.play()

  const before = await server.state()
  assert.ok(before.playback.nextTimedAdAt, 'ayar yapılınca bir sonraki reklam zamanı belirlenmeli')

  // A minute of music, then the ad at the next track change.
  const air = await recordAirplay(server, 110)
  assert.ok(air.some(x => x.type === 'ad'),
    `zamanlı reklam çalmalı (görülen: ${air.map(a => a.type).join(',')})`)

  // And the schedule must move forward, or it would fire on every track change from then on.
  const after = await server.state()
  assert.ok(new Date(after.playback.nextTimedAdAt).getTime() > Date.now(),
    'çaldıktan sonra bir sonraki reklam zamanı ileriye alınmalı')
})

test('elle reklam sayacı sıfırlar', { timeout: 180000 }, async t => {
  // Otherwise pressing "play an ad now" would be followed by the automatic one moments later.
  const server = await startServer({ music: [makeTone(8, 440), makeTone(8, 660)], ads: [makeTone(3, 300)] })
  t.after(() => server.stop())

  await server.api('/api/settings', 'PATCH', {
    adSettings: { songsEnabled: true, songsEvery: 5, manualResetsCounters: true }
  })
  await server.play()
  await waitFor(async () => (await server.state()).current, { label: 'yayın başladı' })

  const res = await server.api('/api/control', 'POST', { action: 'manualAd' })
  assert.equal(res.status, 200)
  await sleep(1500)

  const state = await server.state()
  assert.equal(state.playback.currentType, 'ad', 'elle istenen reklam hemen çalmalı')
  assert.equal(state.playback.tracksSinceAd, 0, 'sayaç sıfırlanmalı')
})

test('reklam bittiğinde müziğe dönülür', { timeout: 180000 }, async t => {
  // An ad that leaves the station on the ad folder would loop advertisements at the café.
  const server = await startServer({ music: [makeTone(6, 440), makeTone(6, 660)], ads: [makeTone(3, 300)] })
  t.after(() => server.stop())

  await server.api('/api/settings', 'PATCH', { adSettings: { songsEnabled: true, songsEvery: 1 } })
  await server.play()
  await waitFor(async () => (await server.state()).playback.currentType === 'ad',
    { timeoutMs: 60000, intervalMs: 500, label: 'reklam çaldı' })

  const backToMusic = await waitFor(async () => {
    const s = await server.state()
    return s.playback.currentType === 'music' ? s : null
  }, { timeoutMs: 60000, intervalMs: 500, label: 'müziğe dönüldü' })
  assert.equal(backToMusic.playback.currentType, 'music', 'reklamdan sonra müzik çalmalı')
})

// Every test above reads currentType from the state. An ad that is selected, counted and
// logged — but whose file never reaches the speakers — passes all of them, and the café loses
// the thing it is paid for without anyone noticing. Ads are the one part of this station that
// is a business obligation, so at least once it has to be checked where it matters.
//
// Music and ads are given tones an octave and a half apart, so the broadcast itself says
// which one is on the air.
test('reklam ekranda değil, hoparlörde çalar', { timeout: 300000 }, async t => {
  const MUSIC_HZ = 300
  const AD_HZ = 1200
  const server = await startServer({ music: [makeTone(120, MUSIC_HZ)], ads: [makeTone(20, AD_HZ)] })
  t.after(() => server.stop())

  await server.play()
  const hearingMusic = await waitFor(async () => {
    const measured = await measureBroadcast(server.port, 4)
    return measured.rms > 0.05 && measured.frequency < 700 ? measured : null
  }, { timeoutMs: 60000, intervalMs: 0, label: 'önce müzik duyulsun' })
  assert.ok(hearingMusic.frequency < 700, `hazırlık: müzik tonu bekleniyordu, ölçülen: ${Math.round(hearingMusic.frequency)} Hz`)

  await server.api('/api/control', 'POST', { action: 'manualAd' })

  const hearingAd = await waitFor(async () => {
    const measured = await measureBroadcast(server.port, 4)
    return measured.frequency > 700 ? measured : null
  }, { timeoutMs: 60000, intervalMs: 0, label: 'reklam duyulsun' })
  assert.ok(hearingAd.rms > 0.05, `reklam duyulur seviyede olmalı, seviye: ${hearingAd.rms.toFixed(4)}`)
  assert.ok(hearingAd.frequency > 700, `yayında reklam tonu olmalı, ölçülen: ${Math.round(hearingAd.frequency)} Hz`)

  // And the café must get its music back — an ad that leaves the station on the ad folder
  // would play advertisements at the customers all afternoon.
  const backToMusic = await waitFor(async () => {
    const measured = await measureBroadcast(server.port, 4)
    return measured.rms > 0.05 && measured.frequency < 700 ? measured : null
  }, { timeoutMs: 90000, intervalMs: 0, label: 'müziğe dönülsün' })
  assert.ok(backToMusic.frequency < 700, `reklam bitince müzik dönmeli, ölçülen: ${Math.round(backToMusic.frequency)} Hz`)
})

// Two sliders, and nothing anywhere checked that each one moves the thing it is labelled for.
// The station has already been found twice with a setting wired to nothing, and this is the
// pair most likely to be confused in code: the wrong one would mean the operator turns ads
// down and the café hears no difference at all.
//
// Measured on ONE ad, mid-play, so nothing but the setting changes between readings.
test('reklam sesi kaydırıcısı reklamı etkiler, müzik kaydırıcısı etkilemez', { timeout: 300000 }, async t => {
  const server = await startServer({ music: [makeTone(180, 300)], ads: [makeTone(90, 1200)] })
  t.after(() => server.stop())

  await server.api('/api/control', 'POST', { action: 'musicVolume', value: 100 })
  await server.api('/api/control', 'POST', { action: 'adVolume', value: 100 })
  await server.play()
  await waitFor(async () => (await server.state()).current, { label: 'yayın başlasın' })

  await server.api('/api/control', 'POST', { action: 'manualAd' })
  const loudAd = await waitFor(async () => {
    const measured = await measureBroadcast(server.port, 4)
    return measured.frequency > 700 && measured.rms > 0.05 ? measured : null
  }, { timeoutMs: 60000, intervalMs: 0, label: 'reklam duyulsun' })

  // Same ad, still playing. Only the ad slider moves.
  await server.api('/api/control', 'POST', { action: 'adVolume', value: 25 })
  const quietAd = await waitFor(async () => {
    const measured = await measureBroadcast(server.port, 4)
    return measured.frequency > 700 ? measured : null
  }, { timeoutMs: 30000, intervalMs: 0, label: 'kısılmış reklam ölçülsün' })
  assert.ok(quietAd.rms < loudAd.rms * 0.6,
    `reklam sesi kısılmalı: ${loudAd.rms.toFixed(4)} -> ${quietAd.rms.toFixed(4)}`)

  // And the music slider must not touch it — this is the assertion that proves the two
  // knobs are not crossed, which no amount of reading the state could show.
  await server.api('/api/control', 'POST', { action: 'musicVolume', value: 5 })
  const stillQuiet = await waitFor(async () => {
    const measured = await measureBroadcast(server.port, 4)
    return measured.frequency > 700 ? measured : null
  }, { timeoutMs: 30000, intervalMs: 0, label: 'reklam ölçülsün' })
  assert.ok(Math.abs(stillQuiet.rms - quietAd.rms) < quietAd.rms * 0.5,
    `müzik kaydırıcısı reklamı değiştirmemeli: ${quietAd.rms.toFixed(4)} -> ${stillQuiet.rms.toFixed(4)}`)
})
