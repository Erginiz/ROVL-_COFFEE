// The music lives on a real disk in a real café: a USB drive gets unplugged, someone tidies
// the folder while the station is playing from it, a drive fills up. None of that should
// take the station off the air, and none of it should be silent — an operator who cannot see
// what happened cannot fix it.
//
// The rule these tests hold the code to: the broadcast survives, and the reason is visible.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { startServer, makeTone, waitFor, sleep } = require('../helpers/harness.cjs')

test('müzik klasörü kaybolursa yayın çökmez ve geri gelince toparlar', { timeout: 240000 }, async t => {
  // The USB drive is pulled, or a network share drops: readdir starts throwing on every scan.
  // Playback is paused first — not to make the test easier, but because Windows will not let
  // anyone delete a file a process still has open, so "the folder vanished mid-song" is not
  // a state this platform can actually reach. What it CAN reach, and what breaks stations,
  // is the folder being gone while the station keeps scanning it.
  const server = await startServer({ music: [makeTone(20, 440), makeTone(20, 660)] })
  t.after(() => server.stop())
  await server.play()
  const meter = server.listen()
  t.after(() => meter.close())
  await waitFor(() => meter.status === 200, { label: '/live.mp3' })
  assert.ok((await meter.sample(3000)) > 5000, 'önce ses akmalı')

  await server.api('/api/control', 'POST', { action: 'stop' })
  await sleep(1500)
  fs.rmSync(path.join(server.dataDir, 'Music'), { recursive: true, force: true })

  // Several scan cycles with the folder simply not there.
  await sleep(20000)
  const state = await server.state()
  assert.ok(state.playback, 'API yanıt vermeye devam etmeli')
  assert.ok(!meter.done, 'yayın ucu açık kalmalı')

  // Put it back: the station has to find the music again on its own — nobody is going to
  // restart it, and nobody would know that is what it needed.
  fs.mkdirSync(path.join(server.dataDir, 'Music'), { recursive: true })
  fs.copyFileSync(makeTone(20, 880), path.join(server.dataDir, 'Music', 'geri-geldi.mp3'))
  await server.api('/api/rescan', 'POST')

  const recovered = await waitFor(async () => {
    const s = await server.state()
    return s.music.some(m => m.filename === 'geri-geldi.mp3') ? s : null
  }, { timeoutMs: 60000, intervalMs: 1000, label: 'klasör geri geldi' })
  assert.ok(recovered.music.length >= 1, 'dosyalar tekrar bulunmalı')

  // And it must be playable again.
  await server.play()
  assert.ok((await meter.sample(4000)) > 5000, 'klasör döndükten sonra yayın akmalı')
})

test('elle silinen (çalmayan) dosya kütüphaneden düşer', { timeout: 240000 }, async t => {
  // Someone tidies the folder in Explorer. The entry must not linger, pointing at nothing.
  const server = await startServer({ music: [makeTone(20, 440), makeTone(20, 660)] })
  t.after(() => server.stop())
  await server.play()
  const playing = await waitFor(async () => (await server.state()).current, { label: 'parça çalıyor' })

  const state = await server.state()
  const idle = state.music.find(m => m.filename !== playing.filename)
  assert.ok(idle, 'çalmayan bir parça olmalı')
  fs.rmSync(path.join(server.dataDir, 'Music', idle.filename), { force: true })

  await waitFor(async () => {
    const s = await server.state()
    return !s.music.some(m => m.filename === idle.filename)
  }, { timeoutMs: 60000, intervalMs: 1000, label: 'silinen dosya kütüphaneden düştü' })

  const after = await server.state()
  assert.ok(!after.queues.music.includes(idle.id), 'kuyrukta da kalmamalı')
})

test('uygulamadan silinen parça bir sonraki taramada geri gelmez', { timeout: 240000 }, async t => {
  // The delete endpoint removes the library entry and unlinks the file. If the unlink ever
  // failed silently — Windows refuses to delete an open file — the entry would go, the file
  // would stay, and the next scan would add it straight back: "I deleted it and it came back."
  const server = await startServer({ music: [makeTone(25, 440), makeTone(25, 660)] })
  t.after(() => server.stop())
  await server.play()
  const playing = await waitFor(async () => (await server.state()).current, { label: 'parça çalıyor' })

  const res = await server.api(`/api/media/music/${playing.id}`, 'DELETE')
  assert.equal(res.status, 204)
  await sleep(1000)
  assert.ok(!fs.existsSync(path.join(server.dataDir, 'Music', playing.filename)),
    'dosya diskten gerçekten silinmeli')

  // Give the periodic scan a full cycle to prove it does not resurrect it.
  await sleep(20000)
  await server.api('/api/rescan', 'POST')
  const after = await server.state()
  assert.ok(!after.music.some(m => m.filename === playing.filename),
    'silinen parça taramadan sonra geri gelmemeli')
})

test('durum dosyası yazılamazsa istasyon çalmaya devam eder', { timeout: 180000 }, async t => {
  // A full disk, or a folder someone made read-only. Losing the ability to SAVE settings is
  // annoying; losing the music because of it would be a disaster.
  const server = await startServer({ music: [makeTone(20, 440)] })
  t.after(() => server.stop())
  await server.play()

  const meter = server.listen()
  t.after(() => meter.close())
  await waitFor(() => meter.status === 200, { label: '/live.mp3' })

  // Make the state path unwritable by replacing it with a directory: every write now fails.
  const statePath = path.join(server.dataDir, 'station.json')
  await waitFor(() => fs.existsSync(statePath), { timeoutMs: 25000, label: 'durum yazıldı' })
  fs.rmSync(statePath, { force: true })
  fs.mkdirSync(statePath)
  t.after(() => { try { fs.rmSync(statePath, { recursive: true, force: true }) } catch {} })

  // Keep using the station: settings changes will fail to persist but must not throw.
  for (let i = 0; i < 5; i++) {
    const res = await server.api('/api/control', 'POST', { action: 'musicVolume', value: 60 + i })
    assert.ok(res.status < 500, `ses değişikliği sunucu hatası vermemeli (${res.status})`)
  }
  await sleep(3000)
  assert.ok((await meter.sample(4000)) > 5000, 'kayıt yapılamasa da yayın akmalı')
})

test('okunamayan dosya sonsuza dek yeniden denenmez ve operatöre bildirilir', { timeout: 300000 }, async t => {
  // A half-copied file: present on disk, unreadable. Two things used to go wrong at once —
  // the station re-probed it on EVERY 15-second scan (an ffmpeg process each time, forever,
  // each marking the library "changed" and fanning a full state broadcast to every phone),
  // and the operator was never told, so the track was simply one that never played.
  const server = await startServer({ music: [makeTone(20, 440)], corruptMusic: 1 })
  t.after(() => server.stop())
  await server.play()

  const meter = server.listen()
  t.after(() => meter.close())
  await waitFor(() => meter.status === 200, { label: '/live.mp3' })

  // Give it several scan cycles: after a few attempts it must stop and say so.
  const reported = await waitFor(async () => {
    const s = await server.state()
    return (s.history || []).some(h => /okunamıyor/i.test(h.title)) ? s : null
  }, { timeoutMs: 120000, intervalMs: 2000, label: 'bozuk dosya bildirildi' })

  const broken = reported.music.find(m => /^broken-/.test(m.filename))
  assert.ok(broken, 'bozuk dosya kütüphanede görünmeli')
  assert.ok(broken.probeFailures >= 3, `denemeler sayılmalı (okunan: ${broken.probeFailures}）`.replace('）', ')'))

  // And it must now STAY given up on rather than climbing every scan.
  const attemptsAtGiveUp = broken.probeFailures
  await sleep(35000)
  const later = await server.state()
  const stillBroken = later.music.find(m => /^broken-/.test(m.filename))
  assert.equal(stillBroken.probeFailures, attemptsAtGiveUp,
    'vazgeçtikten sonra yeniden denenmemeli')

  assert.ok((await meter.sample(3000)) > 5000, 'bu sırada yayın akmalı')
})

test('reklam klasörü boşken istasyon normal çalışır', { timeout: 180000 }, async t => {
  // Plenty of cafés never add an ad. The ad rules must simply do nothing.
  const server = await startServer({ music: [makeTone(10, 440), makeTone(10, 660)], ads: [] })
  t.after(() => server.stop())

  await server.api('/api/settings', 'PATCH', { adSettings: { songsEnabled: true, songsEvery: 1 } })
  await server.play()

  const meter = server.listen()
  t.after(() => meter.close())
  await waitFor(() => meter.status === 200, { label: '/live.mp3' })

  // Several track changes with the ad rule constantly "due" and no ads to play.
  await sleep(25000)
  assert.ok((await meter.sample(4000)) > 5000, 'reklam yokken de müzik akmalı')
  const state = await server.state()
  assert.equal(state.playback.currentType, 'music', 'müzik çalmaya devam etmeli')
})

test('çok uzun ve alışılmadık dosya adları kütüphaneyi bozmaz', { timeout: 240000 }, async t => {
  // Downloads bring names with unicode, emoji, spaces and punctuation. They end up in URLs,
  // on disk, and in the JSON the phones receive.
  const server = await startServer({ music: [] })
  t.after(() => server.stop())

  const tone = fs.readFileSync(makeTone(6, 500))
  const names = [
    'Şarkı Adı — Çok Özel Karakterler ğüşiöç ĞÜŞİÖÇ.mp3',
    'a'.repeat(120) + '.mp3',
    'boşluklu   isim   (remix) [2024].mp3'
  ]
  for (const name of names) {
    fs.writeFileSync(path.join(server.dataDir, 'Music', name), tone)
  }
  await server.api('/api/rescan', 'POST')

  const state = await waitFor(async () => {
    const s = await server.state()
    return s.music.length >= names.length ? s : null
  }, { timeoutMs: 60000, intervalMs: 1000, label: 'dosyalar tarandı' })

  assert.ok(state.music.length >= 3, 'tüm dosyalar kütüphaneye girmeli')
  for (const item of state.music) {
    assert.ok(item.title && item.title.length > 0, 'her parçanın başlığı olmalı')
    assert.ok(item.id, 'her parçanın kimliği olmalı')
  }

  // And one of them has to actually play.
  await server.play()
  const meter = server.listen()
  t.after(() => meter.close())
  await waitFor(() => meter.status === 200, { label: '/live.mp3' })
  assert.ok((await meter.sample(4000)) > 5000, 'alışılmadık adlı dosya çalabilmeli')
})
