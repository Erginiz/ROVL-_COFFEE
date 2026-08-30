// What the café actually hears. Every other test in this suite proves bytes are moving;
// these decode the broadcast and measure it, because a chain that halved every sample,
// swapped a track for silence, or dropped the announcement into a void would pass all of
// them and still be broken in the room.

const test = require('node:test')
const assert = require('node:assert')
const path = require('path')
const fs = require('fs')
const { execFileSync } = require('child_process')
const { startServer, makeTone, waitFor, sleep } = require('../helpers/harness.cjs')
const { measureBroadcast } = require('../helpers/audio-analysis.cjs')

const ffmpegPath = require(path.join(__dirname, '..', '..', 'node_modules', 'ffmpeg-static'))

// A tone at a chosen volume, so level changes can be measured rather than assumed.
function toneAt(seconds, freq, volume, label) {
  const dir = path.join(require('os').tmpdir(), 'rovli-test-fixtures')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `q-${label}.mp3`)
  if (!fs.existsSync(file)) {
    execFileSync(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${seconds}`,
      '-af', `volume=${volume}`, '-b:a', '128k', file])
  }
  return file
}

// s16le mono PCM, the shape the browser's microphone capture sends.
function pcmTone({ samples = 4800, rate = 48000, freq = 1500, amplitude = 0.7 } = {}) {
  const buf = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 32767 * amplitude), i * 2)
  }
  return buf
}

test('çalınan ses gerçekten yayına çıkıyor (frekans korunuyor)', { timeout: 300000 }, async t => {
  // End to end: a 440 Hz tone goes into the library, and 440 Hz has to come out of the
  // stream. This is the whole chain — decoder, mixer, encoder — verified by ear rather than
  // by byte count.
  const server = await startServer({ music: [toneAt(40, 440, 0.5, 'a440')] })
  t.after(() => server.stop())
  await server.play()
  await waitFor(async () => (await server.state()).current, { label: 'yayın başladı' })
  await sleep(3000)

  const measured = await measureBroadcast(server.port, 6)
  t.after(() => measured.cleanup())

  assert.ok(measured.samples > 100000, `yeterli ses yakalanmalı (${measured.samples} örnek)`)
  assert.ok(measured.rms > 0.01, `yayın sessiz olmamalı (RMS ${measured.rms.toFixed(4)})`)
  assert.ok(Math.abs(measured.frequency - 440) < 40,
    `440 Hz bekleniyordu, ölçülen ${measured.frequency.toFixed(0)} Hz`)
})

test('ses seviyesi ayarı çıkışta gerçekten duyuluyor', { timeout: 300000 }, async t => {
  // The slider must move the actual output, not just a number on the panel. Halving the
  // level should show up as roughly -6 dB.
  const server = await startServer({ music: [toneAt(60, 440, 0.5, 'a440')] })
  t.after(() => server.stop())
  await server.play()
  await waitFor(async () => (await server.state()).current, { label: 'yayın başladı' })

  await server.api('/api/control', 'POST', { action: 'musicVolume', value: 100 })
  await sleep(2500)
  const loud = await measureBroadcast(server.port, 5)
  t.after(() => loud.cleanup())

  await server.api('/api/control', 'POST', { action: 'musicVolume', value: 50 })
  await sleep(2500)
  const quiet = await measureBroadcast(server.port, 5)
  t.after(() => quiet.cleanup())

  assert.ok(loud.rms > 0.01 && quiet.rms > 0.001, 'iki ölçüm de ses içermeli')
  const ratio = quiet.rms / loud.rms
  assert.ok(ratio < 0.75, `%50'de belirgin biçimde kısılmalı (oran ${ratio.toFixed(2)})`)
  assert.ok(ratio > 0.25, `tamamen susmamalı (oran ${ratio.toFixed(2)})`)
})

test('duraklatma gerçekten sessizlik yayınlar (bağlantı kopmadan)', { timeout: 300000 }, async t => {
  // Pausing must produce silence on a stream that stays open — that is what keeps every
  // phone connected instead of reconnecting when the music comes back.
  const server = await startServer({ music: [toneAt(60, 440, 0.5, 'a440')] })
  t.after(() => server.stop())
  await server.play()
  await waitFor(async () => (await server.state()).current, { label: 'yayın başladı' })
  await sleep(2500)

  const playing = await measureBroadcast(server.port, 4)
  t.after(() => playing.cleanup())
  assert.ok(playing.rms > 0.01, 'önce ses olmalı')

  await server.api('/api/control', 'POST', { action: 'pause' })
  await sleep(2000)
  const paused = await measureBroadcast(server.port, 4)
  t.after(() => paused.cleanup())

  assert.ok(paused.samples > 50000, 'duraklatmada da veri akmalı (bağlantı açık kalmalı)')
  assert.ok(paused.rms < playing.rms * 0.2,
    `duraklatmada sessizlik olmalı (çalarken ${playing.rms.toFixed(4)}, duraklıyken ${paused.rms.toFixed(4)})`)
})

test('anons yayına gerçekten karışıyor', { timeout: 300000 }, async t => {
  // The failure this guards against is the one nobody notices until customers say so: the
  // panel shows a live microphone and not a sound reaches the room.
  const server = await startServer({ music: [toneAt(60, 300, 0.4, 'a300')] })
  t.after(() => server.stop())
  await server.play()
  await waitFor(async () => (await server.state()).current, { label: 'yayın başladı' })
  await sleep(2500)

  const musicOnly = await measureBroadcast(server.port, 4)
  t.after(() => musicOnly.cleanup())
  assert.ok(Math.abs(musicOnly.frequency - 300) < 60,
    `önce sadece müzik olmalı (~300 Hz, ölçülen ${musicOnly.frequency.toFixed(0)})`)

  // Start an announcement and keep feeding it a much higher tone.
  await server.api('/api/control', 'POST', { action: 'microphoneStart', value: 48000 })
  let feeding = true
  const feed = (async () => {
    while (feeding) {
      await server.raw('/api/mic/chunk', 'POST', pcmTone({ freq: 1500 }),
        { 'Content-Type': 'application/octet-stream' }).catch(() => {})
      await sleep(80)
    }
  })()
  await sleep(3000)

  const withMic = await measureBroadcast(server.port, 5)
  t.after(() => withMic.cleanup())
  feeding = false
  await feed
  await server.api('/api/control', 'POST', { action: 'microphoneStop' })

  // The announcement is well above the music in pitch, so its arrival pulls the measured
  // frequency up. Silence from the mic would leave it sitting at the music's 300 Hz.
  assert.ok(withMic.frequency > musicOnly.frequency + 100,
    `anons yayına karışmalı (müzik ${musicOnly.frequency.toFixed(0)} Hz, anonsla ${withMic.frequency.toFixed(0)} Hz)`)
})

test('parça değişiminde yayın kesintiye uğramaz', { timeout: 300000 }, async t => {
  // The point of the persistent encoder: a track change must not be audible as a gap.
  const server = await startServer({ music: [toneAt(8, 440, 0.5, 'short440'), toneAt(8, 880, 0.5, 'short880')] })
  t.after(() => server.stop())
  await server.play()
  await waitFor(async () => (await server.state()).current, { label: 'yayın başladı' })
  await sleep(2000)

  // Long enough to span at least one track change (8-second files).
  const across = await measureBroadcast(server.port, 12)
  t.after(() => across.cleanup())

  assert.ok(across.samples > 300000, 'kesintisiz veri gelmeli')
  assert.ok(across.rms > 0.01, `parça değişimi boyunca ses sürmeli (RMS ${across.rms.toFixed(4)})`)
})
