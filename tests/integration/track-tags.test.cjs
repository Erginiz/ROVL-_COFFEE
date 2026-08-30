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
