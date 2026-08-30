// Loudness normalisation is why one track is not inaudible while the next is jarring: the
// café's files span roughly 21 dB (a phone-recorded announcement against a modern master),
// and no single volume slider can fix that — it moves everything at once.
//
// The analysis is rationed on purpose (it decodes whole files), so the property that matters
// is not "every track is measured immediately" but "every track ends up measured, and an
// unmeasured one still plays at its own level instead of being silenced or skipped".

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { startServer, makeTone, waitFor, sleep } = require('../helpers/harness.cjs')

const ffmpegPath = require(path.join(__dirname, '..', '..', 'node_modules', 'ffmpeg-static'))

// A tone at a chosen volume, so a quiet file and a loud file can be compared.
function makeToneAt(seconds, freq, volume, label) {
  const dir = path.join(require('os').tmpdir(), 'rovli-test-fixtures')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `vol-${label}.mp3`)
  if (!fs.existsSync(file)) {
    execFileSync(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${seconds}`,
      '-af', `volume=${volume}`, '-b:a', '128k', file])
  }
  return file
}

test('sessiz ve gür parçalar farklı kazançlarla işaretlenir', { timeout: 300000 }, async t => {
  // The whole point: the quiet file must be marked for a BOOST relative to the loud one.
  const quiet = makeToneAt(6, 440, 0.05, 'quiet')
  const loud = makeToneAt(6, 660, 1.0, 'loud')
  const server = await startServer({ music: [quiet, loud] })
  t.after(() => server.stop())

  // Analysis is rationed per scan pass, so wait for both to be measured rather than assuming.
  const state = await waitFor(async () => {
    const s = await server.state()
    return s.music.length === 2 && s.music.every(m => m.gainDb != null) ? s : null
  }, { timeoutMs: 90000, intervalMs: 1000, label: 'iki parça da ölçüldü' })

  const q = state.music.find(m => /track-0/.test(m.filename))
  const l = state.music.find(m => /track-1/.test(m.filename))
  assert.ok(q && l, 'iki parça da kütüphanede olmalı')
  assert.ok(q.gainDb > l.gainDb,
    `sessiz parça daha çok yükseltilmeli (sessiz ${q.gainDb} dB, gür ${l.gainDb} dB)`)
})

test('kazanç makul sınırlar içinde kalır', { timeout: 300000 }, async t => {
  // An unbounded boost would turn a quiet recording into clipping; an unbounded cut would
  // make a loud one inaudible. Both bounds exist and both matter.
  const veryQuiet = makeToneAt(6, 440, 0.02, 'veryquiet')
  const server = await startServer({ music: [veryQuiet] })
  t.after(() => server.stop())

  const state = await waitFor(async () => {
    const s = await server.state()
    return s.music[0]?.gainDb != null ? s : null
  }, { timeoutMs: 90000, intervalMs: 1000, label: 'ölçüldü' })

  const gain = state.music[0].gainDb
  assert.ok(gain <= 12, `kazanç üst sınırı aşmamalı (okunan: ${gain} dB)`)
  assert.ok(gain >= -20, `kazanç alt sınırı aşmamalı (okunan: ${gain} dB)`)
})

test('ölçülemeyen dosya yine de çalar (sessize düşmez)', { timeout: 300000 }, async t => {
  // A file ffmpeg cannot measure must play at its own level. Storing "no gain" as silence,
  // or skipping the track, would lose songs from the rotation for an invisible reason.
  const server = await startServer({ music: [makeTone(8, 520)] })
  t.after(() => server.stop())

  await server.play()
  const meter = server.listen()
  t.after(() => meter.close())
  await waitFor(() => meter.status === 200, { label: '/live.mp3' })

  // Whatever the analysis decided, audio has to be flowing.
  assert.ok((await meter.sample(4000)) > 5000, 'ses akmalı')
  const state = await server.state()
  assert.equal(state.playback.status, 'playing')
})

test('analiz yayını kesmez', { timeout: 300000 }, async t => {
  // Analysis decodes whole files. If it competed with playback the café would hear it.
  const server = await startServer({
    music: [makeTone(10, 440), makeTone(10, 660), makeTone(10, 880), makeTone(10, 220)]
  })
  t.after(() => server.stop())

  await server.play()
  const meter = server.listen()
  t.after(() => meter.close())
  await waitFor(() => meter.status === 200, { label: '/live.mp3' })

  // Measure across several scan passes, which is when the analysis runs.
  const first = await meter.sample(5000)
  const second = await meter.sample(5000)
  const third = await meter.sample(5000)
  for (const [i, sample] of [first, second, third].entries()) {
    assert.ok(sample > 5000, `${i + 1}. pencerede ses akmalı (alınan: ${sample})`)
  }
})

test('kütüphaneye elle atılan dosya kazancıyla birlikte görünür', { timeout: 300000 }, async t => {
  // "Klasörü Aç" is how the operator is told to add music, so a file dropped straight into
  // the folder has to end up as complete a library entry as an uploaded one.
  const server = await startServer({ music: [] })
  t.after(() => server.stop())

  fs.copyFileSync(makeTone(6, 700), path.join(server.dataDir, 'Music', 'elle-atilan.mp3'))
  await server.api('/api/rescan', 'POST')

  const entry = await waitFor(async () => {
    const s = await server.state()
    const found = s.music.find(m => m.filename === 'elle-atilan.mp3')
    return found && found.gainDb != null && found.durationSeconds ? found : null
  }, { timeoutMs: 90000, intervalMs: 1000, label: 'dosya tarandı ve ölçüldü' })

  assert.ok(entry.durationSeconds >= 5, `süre bulunmalı (okunan: ${entry.durationSeconds})`)
  assert.equal(typeof entry.gainDb, 'number', 'kazanç ölçülmeli')
  assert.ok(entry.title, 'başlık dosya adından türetilmeli')
})
