// /api/settings writes straight into the state the engine runs on, so what it accepts is
// not a formality. The endless-ads loop below was reachable through completely ordinary
// use: selecting the "every N songs" number and deleting it to type a new one sends
// Number('') === 0, and a counter that is always >= 0 schedules an ad after every advance.
//
// The tests also pin the legitimate paths, because validation that breaks the real UI is
// worse than no validation.

const test = require('node:test')
const assert = require('node:assert')
const { startServer, makeTone, waitFor, sleep } = require('../helpers/harness.cjs')

test('songsEvery=0 sonsuz reklam döngüsü yaratmaz', { timeout: 180000 }, async t => {
  // Reproduced before the fix: after this setting the station played "ad ad ad ad ..." and
  // never returned to music. Short files so several track changes happen inside the test.
  const server = await startServer({
    music: [makeTone(4, 440), makeTone(4, 660)],
    ads: [makeTone(3, 300), makeTone(3, 900)]
  })
  t.after(() => server.stop())

  await server.play()
  await sleep(1500)
  const res = await server.api('/api/settings', 'PATCH', { adSettings: { songsEnabled: true, songsEvery: 0 } })
  assert.equal(res.status, 200, 'istek reddedilmemeli — kullanıcı sadece sayıyı siliyor')
  assert.ok(res.json.adSettings.songsEvery >= 1, `songsEvery en az 1 olmalı (okunan: ${res.json.adSettings.songsEvery})`)

  // Watch what actually goes on air: music has to keep its turn.
  const seen = []
  for (let i = 0; i < 12; i++) {
    const s = await server.state()
    seen.push(s.playback.currentType || '-')
    await sleep(2000)
  }
  assert.ok(seen.includes('music'), `müzik çalmaya devam etmeli, görülen: ${seen.join(' ')}`)
})

test('bozuk ayar değerleri kaydedilmez, önceki ayar korunur', { timeout: 120000 }, async t => {
  const server = await startServer({ music: [makeTone(10)] })
  t.after(() => server.stop())

  const before = (await server.state()).adSettings
  for (const bad of [0, -3, 'abc', null, NaN, Infinity]) {
    const res = await server.api('/api/settings', 'PATCH', { adSettings: { songsEvery: bad, timedMinutes: bad } })
    assert.ok(res.status < 500, `songsEvery=${bad} sunucu hatası vermemeli`)
  }
  const after = (await server.state()).adSettings
  assert.equal(after.songsEvery, before.songsEvery, 'geçersiz değer eski ayarı bozmamalı')
  assert.equal(after.timedMinutes, before.timedMinutes, 'geçersiz süre eski ayarı bozmamalı')

  // An absurd interval must not corrupt the schedule either: the timestamp is computed as
  // now + minutes, which used to throw once it left the range a Date can represent.
  const huge = await server.api('/api/settings', 'PATCH', { adSettings: { timedEnabled: true, timedMinutes: 1e15 } })
  assert.ok(huge.status < 500, 'aşırı büyük süre sunucu hatası vermemeli')
  const state = await server.state()
  assert.ok(!Number.isNaN(new Date(state.playback.nextTimedAdAt).getTime()),
    'sonraki reklam zamanı geçerli bir tarih olmalı')
})

test('ayarlar üzerinden oynatma durumu ele geçirilemez', { timeout: 120000 }, async t => {
  // /api/settings used to spread its payload into state.playback, so a caller could set
  // status, currentId or an unclamped volume — state the transport endpoint carefully
  // validates. Only shuffle belongs here.
  const server = await startServer({ music: [makeTone(10)] })
  t.after(() => server.stop())

  const before = await server.state()
  const res = await server.api('/api/settings', 'PATCH', {
    playback: { shuffle: !before.playback.shuffle, status: 'playing', currentId: 'sahte-id', musicVolume: 99999 }
  })
  assert.equal(res.status, 200)

  const after = (await res.json.playback) ? res.json.playback : (await server.state()).playback
  assert.equal(after.shuffle, !before.playback.shuffle, 'karıştırma ayarı normal şekilde çalışmalı')
  assert.notEqual(after.currentId, 'sahte-id', 'çalan parça ayarlardan değiştirilememeli')
  assert.ok(Number(after.musicVolume) <= 200, `ses seviyesi sınırı aşılmamalı (okunan: ${after.musicVolume})`)
})

test('arayüzün gönderdiği normal ayarlar çalışmaya devam eder', { timeout: 120000 }, async t => {
  // Guard against over-tightening: these are the exact payloads the admin panel sends.
  const server = await startServer({ music: [makeTone(10)] })
  t.after(() => server.stop())

  const shuffle = await server.api('/api/settings', 'PATCH', { playback: { shuffle: false } })
  assert.equal(shuffle.json.playback.shuffle, false, 'karıştırma kapatılabilmeli')

  const ads = await server.api('/api/settings', 'PATCH', { adSettings: { songsEnabled: true, timedEnabled: false, songsEvery: 7 } })
  assert.equal(ads.json.adSettings.songsEvery, 7, 'geçerli reklam aralığı kaydedilmeli')
  assert.equal(ads.json.adSettings.songsEnabled, true)

  const timed = await server.api('/api/settings', 'PATCH', { adSettings: { timedEnabled: true, timedMinutes: 45 } })
  assert.equal(timed.json.adSettings.timedMinutes, 45, 'geçerli dakika kaydedilmeli')

  const duck = await server.api('/api/settings', 'PATCH', { microphone: { ducking: 65 } })
  assert.equal(duck.json.microphone.ducking, 65, 'anons kısma seviyesi kaydedilmeli')

  const ezan = await server.api('/api/settings', 'PATCH', { ezan: { enabled: true, il: 'Ankara', durationMinutes: 5 } })
  assert.equal(ezan.json.ezan.enabled, true, 'ezan açılabilmeli')
  assert.equal(ezan.json.ezan.il, 'Ankara', 'il kaydedilmeli')
  assert.equal(ezan.json.ezan.durationMinutes, 5, 'süre kaydedilmeli')
})
