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
