// The listener page shows customers what is playing right now, and the panel lists the
// library by name. Both were showing the file name — "01 - Track 01" — and "Bilinmeyen
// sanatçı" under every single song, because nothing ever looked at the tags inside the MP3s
// the operator dropped into the folder.
//
// The information was already in hand: probing a file for its duration runs ffmpeg -i and
// parses its output, and that same output carries the Metadata block. Reading two more lines
// of a string that is already captured costs nothing — no extra process, no new dependency.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execFileSync } = require('node:child_process')
const ffmpegPath = require('ffmpeg-static')
const { startServer, makeTone, waitFor } = require('../helpers/harness.cjs')

// A real tagged MP3, written the way a music file actually carries its title.
function taggedTone(tags, seconds = 3) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rovli-tag-'))
  const file = path.join(dir, 'tagged.mp3')
  const meta = Object.entries(tags).flatMap(([key, value]) => ['-metadata', `${key}=${value}`])
  execFileSync(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, ...meta, file])
  return file
}

const findByFile = (list, name) => list.find(item => item.filename === name)

test('şarkı adı ve sanatçı dosyanın içinden okunur', async t => {
  const source = taggedTone({ title: 'Kahve Molası', artist: 'Rovli Grubu' })
  const server = await startServer({ music: [] })
  t.after(() => server.stop())

  fs.copyFileSync(source, path.join(server.dataDir, 'Music', 'track-01.mp3'))
  await server.api('/api/rescan', 'POST')

  const track = await waitFor(async () => findByFile((await server.state()).music, 'track-01.mp3'),
    { timeoutMs: 20000, label: 'parça taransın' })
  assert.equal(track.title, 'Kahve Molası', 'başlık dosya adı değil, etiket olmalı')
  assert.equal(track.artist, 'Rovli Grubu')
})

test('etiketi olmayan dosya dosya adına düşer', async t => {
  // Most of a café's library is untagged rips. The fallback has to stay exactly as it was.
  const server = await startServer({ music: [makeTone(3, 440)] })
  t.after(() => server.stop())

  const track = await waitFor(async () => (await server.state()).music[0],
    { timeoutMs: 20000, label: 'parça taransın' })
  assert.equal(track.title, 'track-0', 'etiket yoksa dosya adı kullanılmalı')
  assert.equal(track.artist, 'Bilinmeyen sanatçı')
})

test('yalnızca sanatçısı etiketli dosya yarı yarıya kullanılır', async t => {
  // Partial tags are the norm, and a missing title must not blank out the name.
  const source = taggedTone({ artist: 'Sadece Sanatçı' })
  const server = await startServer({ music: [] })
  t.after(() => server.stop())

  fs.copyFileSync(source, path.join(server.dataDir, 'Music', 'yarim.mp3'))
  await server.api('/api/rescan', 'POST')

  const track = await waitFor(async () => findByFile((await server.state()).music, 'yarim.mp3'),
    { timeoutMs: 20000, label: 'parça taransın' })
  assert.equal(track.title, 'yarim', 'başlık etiketi yoksa dosya adı')
  assert.equal(track.artist, 'Sadece Sanatçı')
})

test('boş ve saçma etiketler dosya adını bozmaz', async t => {
  // Tag fields are attacker-adjacent only in the sense that they come from files someone
  // else made: whitespace-only titles are common in badly ripped libraries, and an empty
  // name on the listener page reads as a broken station.
  const source = taggedTone({ title: '   ', artist: '' })
  const server = await startServer({ music: [] })
  t.after(() => server.stop())

  fs.copyFileSync(source, path.join(server.dataDir, 'Music', 'bosluk.mp3'))
  await server.api('/api/rescan', 'POST')

  const track = await waitFor(async () => findByFile((await server.state()).music, 'bosluk.mp3'),
    { timeoutMs: 20000, label: 'parça taransın' })
  assert.equal(track.title, 'bosluk')
  assert.equal(track.artist, 'Bilinmeyen sanatçı')
})

test('aşırı uzun etiket kırpılır', async t => {
  // Nothing stops a file from carrying a kilobyte of title, and it would be sent to every
  // phone on every library broadcast and laid out across the panel.
  const source = taggedTone({ title: 'A'.repeat(600) })
  const server = await startServer({ music: [] })
  t.after(() => server.stop())

  fs.copyFileSync(source, path.join(server.dataDir, 'Music', 'uzun.mp3'))
  await server.api('/api/rescan', 'POST')

  const track = await waitFor(async () => findByFile((await server.state()).music, 'uzun.mp3'),
    { timeoutMs: 20000, label: 'parça taransın' })
  assert.ok(track.title.length <= 200, `başlık kırpılmalı, uzunluk: ${track.title.length}`)
})

test('etiket okuma yayını bozmaz', async t => {
  // The probe runs during a scan, which runs on the station's own event loop every 15
  // seconds. Whatever it does, the music must not stutter.
  const server = await startServer({ music: [makeTone(20, 440)] })
  t.after(() => server.stop())
  const meter = server.listen()
  t.after(() => meter.close())
  await waitFor(() => meter.status === 200, { label: '/live.mp3' })
  await server.play()

  fs.copyFileSync(taggedTone({ title: 'Sonradan Eklenen', artist: 'X' }),
    path.join(server.dataDir, 'Music', 'sonradan.mp3'))
  await server.api('/api/rescan', 'POST')

  assert.ok((await meter.sample(3000)) > 5000, 'tarama sırasında yayın sürmeli')
})

// Everything above only helps a library that is scanned for the first time. The café already
// has its music indexed, and the scan deliberately skips files it has seen — so without a
// back-fill this change would appear to do nothing for the one person who actually has a
// library, which is the worst possible outcome for a feature.
test('mevcut kütüphanedeki adlar da sonradan düzeltilir', { timeout: 180000 }, async t => {
  // The real upgrade, not an approximation of it: an entry written by an older version —
  // filename as the title, no record of tags ever having been looked at — sitting next to a
  // file that has carried its tags all along.
  const seed = await startServer({ music: [] })
  const dataDir = seed.dataDir
  await seed.stop({ keepData: true })

  fs.copyFileSync(taggedTone({ title: 'Düzeltilmiş Ad', artist: 'Gerçek Sanatçı' }),
    path.join(dataDir, 'Music', 'eski.mp3'))
  fs.writeFileSync(path.join(dataDir, 'station.json'), JSON.stringify({
    music: [{ id: 'eski-1', title: 'eski', artist: 'Bilinmeyen sanatçı', filename: 'eski.mp3', durationSeconds: 3, addedAt: new Date().toISOString() }]
  }, null, 2))

  const server = await startServer({ dataDir, music: [] })
  t.after(() => server.stop())

  const fixed = await waitFor(async () => {
    const track = findByFile((await server.state()).music, 'eski.mp3')
    return track && track.title === 'Düzeltilmiş Ad' ? track : null
  }, { timeoutMs: 90000, label: 'ad düzeltilsin' })
  assert.equal(fixed.artist, 'Gerçek Sanatçı')
  assert.equal(fixed.id, 'eski-1', 'kayıt yeniden oluşturulmamalı, düzeltilmeli')
})

test('etiketi olmayan eski kayıt sonsuza dek yeniden okunmaz', { timeout: 180000 }, async t => {
  // The back-fill runs every 15 seconds for the life of the station. A file with no tags
  // must be read once and then left alone, or an untagged library spawns ffmpeg for ever —
  // the same mistake the duration probe already had to be cured of.
  const server = await startServer({ music: [makeTone(3, 440)] })
  t.after(() => server.stop())

  const track = await waitFor(async () => {
    const found = (await server.state()).music[0]
    return found && found.tagsRead ? found : null
  }, { timeoutMs: 60000, label: 'etiket okundu işareti' })

  assert.equal(track.tagsRead, true, 'okunduğu işaretlenmeli')
  assert.equal(track.title, 'track-0', 'etiketsiz dosya adını korumalı')
})

test('etiket doldurma fırtınası sırasında ses kesilmez', { timeout: 300000 }, async t => {
  // The back-fill spawns up to eight ffmpeg processes per scan pass, every fifteen seconds,
  // until the library is done. On the café's two hundred songs that is several minutes of
  // sustained extra load right after an update — competing with the encoder for a modest PC.
  // Measured rather than assumed, because "it should be fine, the probes are child processes"
  // is exactly the kind of reasoning this project has been wrong about before.
  const many = Array.from({ length: 30 }, (_, i) => makeTone(4, 200 + i * 17))
  const server = await startServer({ music: many })
  t.after(() => server.stop())

  const meter = server.listen()
  t.after(() => meter.close())
  await waitFor(() => meter.status === 200, { label: '/live.mp3' })
  await server.play()

  // Straddle several scan passes, so the measurement covers the back-fill at full tilt.
  const samples = []
  for (let i = 0; i < 5; i++) samples.push(await meter.sample(4000))

  const worst = Math.min(...samples)
  assert.ok(worst > 20000, `en kötü 4 saniyede ${worst} bayt — yayın sekmiş olabilir (örnekler: ${samples.join(', ')})`)

  // And the work must actually have been happening, or the test proves nothing.
  const done = (await server.state()).music.filter(track => track.tagsRead).length
  assert.ok(done > 0, 'ölçüm sırasında etiket doldurma çalışmış olmalı')
})
