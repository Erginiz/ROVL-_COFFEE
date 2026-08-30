// In a real café two people drive this at once: someone at the counter using the panel, and
// someone at a table with the phone panel open. On top of that the station runs its own
// timers — a folder scan every 15 seconds, the ezan check, the loudness analysis.
//
// Every bug this session came from something happening while something else was in flight
// (an upload during a scan, a crash during a write, a restart during a prayer window). These
// tests deliberately overlap operations and check the one thing that must always hold: the
// music keeps playing and the state stays coherent.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { startServer, makeTone, waitFor, sleep } = require('../helpers/harness.cjs')

test('aynı anda gelen kontrol komutları durumu bozmaz', { timeout: 180000 }, async t => {
  // The counter and a phone pressing things at the same moment.
  const server = await startServer({ music: [makeTone(20, 440), makeTone(20, 660), makeTone(20, 880)] })
  t.after(() => server.stop())
  await server.play()
  await waitFor(async () => (await server.state()).current, { label: 'yayın başladı' })

  const commands = ['next', 'pause', 'play', 'next', 'previous', 'play', 'stop', 'play']
  await Promise.all(commands.map(action => server.api('/api/control', 'POST', { action })))
  await sleep(2000)

  const state = await server.state()
  // Whatever order they landed in, the result must be a state that makes sense.
  assert.ok(['playing', 'paused', 'stopped'].includes(state.playback.status),
    `durum geçerli olmalı (okunan: ${state.playback.status})`)
  if (state.playback.currentId) {
    assert.ok(state.music.some(m => m.id === state.playback.currentId),
      'çalan parça kütüphanede olmalı')
  }
  // And the station must still answer.
  assert.ok((await server.state()).playback, 'API yanıt vermeye devam etmeli')
})

test('yayın sürerken yükleme yapılabilir ve ses kesilmez', { timeout: 240000 }, async t => {
  // Adding music mid-service is normal. Two ffmpeg probes run per upload, and the operator
  // must not hear that.
  const server = await startServer({ music: [makeTone(25, 440)] })
  t.after(() => server.stop())
  await server.play()

  const meter = server.listen()
  t.after(() => meter.close())
  await waitFor(() => meter.status === 200, { label: '/live.mp3' })
  assert.ok((await meter.sample(3000)) > 5000, 'önce ses akmalı')

  const content = fs.readFileSync(makeTone(8, 700))
  const uploads = [0, 1, 2].map(i =>
    server.upload('/api/media/music', { filename: `yeni-${i}.mp3`, content }))
  const during = await meter.sample(5000)
  await Promise.all(uploads)

  assert.ok(during > 5000, `yükleme sırasında ses akmalı (alınan: ${during})`)
  assert.ok((await meter.sample(3000)) > 5000, 'yüklemeden sonra da akmalı')

  const state = await server.state()
  const names = state.music.map(m => m.filename)
  assert.equal(names.filter((n, i) => names.indexOf(n) !== i).length, 0, 'çift kayıt olmamalı')
})

test('çalan parça silinirse yayın devam eder', { timeout: 180000 }, async t => {
  // The operator deleting the song that is on air, mid-service.
  const server = await startServer({ music: [makeTone(20, 440), makeTone(20, 660)] })
  t.after(() => server.stop())
  await server.play()

  const meter = server.listen()
  t.after(() => meter.close())
  await waitFor(() => meter.status === 200, { label: '/live.mp3' })
  const playing = await waitFor(async () => (await server.state()).current, { label: 'parça çalıyor' })

  const res = await server.api(`/api/media/music/${playing.id}`, 'DELETE')
  assert.equal(res.status, 204)

  // It has to move to something else and keep the sound going.
  const next = await waitFor(async () => {
    const s = await server.state()
    return s.current && s.current.id !== playing.id ? s.current : null
  }, { timeoutMs: 40000, intervalMs: 500, label: 'başka parçaya geçti' })
  assert.ok(next.id, 'başka bir parça çalmalı')
  assert.ok((await meter.sample(4000)) > 5000, 'silme sonrası ses akmalı')

  // And nothing may be left pointing at the deleted track.
  const after = await server.state()
  assert.ok(!after.music.some(m => m.id === playing.id), 'silinen parça kütüphanede kalmamalı')
  assert.ok(!after.queues.music.includes(playing.id), 'silinen parça kuyrukta kalmamalı')
})

test('çok sayıda eşzamanlı dinleyici yayını bozmaz', { timeout: 180000 }, async t => {
  // A busy café: everyone scans the QR at once.
  const server = await startServer({ music: [makeTone(25, 440)] })
  t.after(() => server.stop())
  await server.play()

  const meters = Array.from({ length: 12 }, () => server.listen())
  t.after(() => meters.forEach(m => m.close()))
  await waitFor(() => meters.every(m => m.status === 200), { timeoutMs: 30000, label: '12 dinleyici bağlandı' })

  const samples = await Promise.all(meters.map(m => m.sample(4000)))
  const silent = samples.filter(s => s < 1000)
  assert.equal(silent.length, 0, `her dinleyici ses almalı (sessiz kalan: ${silent.length}/12)`)

  // The station must still be controllable while serving them all.
  assert.equal((await server.api('/api/control', 'POST', { action: 'next' })).status, 200)
})

test('ayar değişiklikleri yayınla yarışmaz', { timeout: 180000 }, async t => {
  // Volume and ad settings are edited while music plays; none of it may interrupt the audio.
  const server = await startServer({ music: [makeTone(25, 440)], ads: [makeTone(5, 300)] })
  t.after(() => server.stop())
  await server.play()

  const meter = server.listen()
  t.after(() => meter.close())
  await waitFor(() => meter.status === 200, { label: '/live.mp3' })

  const edits = []
  for (let i = 0; i < 15; i++) {
    edits.push(server.api('/api/control', 'POST', { action: 'musicVolume', value: 50 + i }))
    edits.push(server.api('/api/settings', 'PATCH', { adSettings: { songsEvery: 3 + (i % 5) } }))
    edits.push(server.api('/api/settings', 'PATCH', { microphone: { ducking: 20 + i } }))
  }
  const during = await meter.sample(5000)
  await Promise.all(edits)

  assert.ok(during > 5000, `ayar değişiklikleri sırasında ses akmalı (alınan: ${during})`)
  const state = await server.state()
  assert.ok(state.playback.musicVolume >= 50 && state.playback.musicVolume <= 64, 'son ses seviyesi kaydedilmeli')
  assert.ok(state.adSettings.songsEvery >= 3, 'reklam ayarı geçerli kalmalı')
})

test('tarama sürerken yapılan işlemler kaybolmaz', { timeout: 240000 }, async t => {
  // The 15s scan overlaps everything else the operator does.
  const server = await startServer({ music: [makeTone(20, 440)] })
  t.after(() => server.stop())

  // Drop files straight into the folder (the "Klasörü Aç" route) and act at the same time.
  const tone = fs.readFileSync(makeTone(6, 520))
  for (let i = 0; i < 4; i++) {
    fs.writeFileSync(path.join(server.dataDir, 'Music', `toplu-${i}.mp3`), tone)
  }
  const work = [
    server.api('/api/rescan', 'POST'),
    server.api('/api/control', 'POST', { action: 'play' }),
    server.api('/api/settings', 'PATCH', { playback: { shuffle: false } }),
    server.api('/api/rescan', 'POST')
  ]
  await Promise.all(work)

  const state = await waitFor(async () => {
    const s = await server.state()
    return s.music.length >= 5 ? s : null
  }, { timeoutMs: 60000, intervalMs: 1000, label: 'dosyalar tarandı' })

  assert.equal(state.playback.shuffle, false, 'ayar değişikliği tarama tarafından ezilmemeli')
  const names = state.music.map(m => m.filename)
  assert.equal(names.filter((n, i) => names.indexOf(n) !== i).length, 0, 'çift kayıt olmamalı')
})
