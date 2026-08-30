// A café loses power. Not hypothetically — it is the most ordinary thing that happens to a
// computer behind a counter, and the station writes `station.json` about once a second while
// it is playing. So a torn write is not an edge case; it is a matter of time.
//
// What the station did with a torn file was the part that mattered: it caught the parse error,
// silently booted with factory defaults, and one second later saved those defaults over the
// damaged file. The library index, ad schedule, ezan settings and volumes were then gone for
// good — and the operator's only clue was an empty station that looked freshly installed.
//
// These tests hold the line on three things: the file on disk is never left half-written, a
// damaged file never destroys what was there, and the operator is told.

const { test, describe, after } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { startServer, makeTone, sleep } = require('../helpers/harness.cjs')

const running = []
const boot = async options => { const s = await startServer(options); running.push(s); return s }
after(async () => { for (const s of running) { try { await s.stop() } catch {} } })

const statePathOf = dir => path.join(dir, 'station.json')
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } }

describe('Elektrik kesintisi ve bozuk durum dosyası', () => {
  test('yarım kalmış yazma kütüphaneyi yok etmez', async () => {
    // Seed a station that has real work in it, then simulate the power going out in the
    // middle of a save by truncating the file the way a torn write leaves it.
    const first = await boot({ music: [makeTone(4, 440), makeTone(4, 660)] })
    const dataDir = first.dataDir
    const changed = await first.api('/api/settings', 'PATCH', { adSettings: { songsEvery: 7 } })
    assert.equal(changed.status, 200, 'hazırlık: ayar kabul edilmeli')
    await sleep(1500)                                     // let the coalesced save land
    // The backup is deliberately one save behind — that is what makes it a backup. So a
    // setting is only guaranteed recoverable once a later save has rotated it into place.
    // Losing the last second of changes to a power cut is the price; losing the library is not.
    await first.play()
    await sleep(1500)
    await first.stop({ keepData: true })

    const statePath = statePathOf(dataDir)
    const good = fs.readFileSync(statePath, 'utf8')
    const before = JSON.parse(good)
    assert.ok(before.music.length >= 2, 'hazırlık: kütüphane dolu olmalı')
    fs.writeFileSync(statePath, good.slice(0, Math.floor(good.length * 0.6)))

    const second = await boot({ dataDir, music: [] })
    const state = (await second.api('/api/state')).json

    assert.equal(state.adSettings.songsEvery, 7, 'kesinti öncesi ayar geri gelmeli')
    assert.ok(state.music.length >= 2, `kütüphane kurtarılmalı, gelen: ${state.music.length}`)
  })

  test('bozuk dosyanın üstüne varsayılanlar yazılmaz', async () => {
    // The second failure was worse than the first: booting with defaults was survivable,
    // but saving them one second later made the loss permanent.
    const first = await boot({ music: [makeTone(4, 520)] })
    const dataDir = first.dataDir
    await sleep(1500)
    await first.stop({ keepData: true })

    const statePath = statePathOf(dataDir)
    fs.writeFileSync(statePath, '{"music": [{"id": "m0", "titl')   // torn mid-token

    const second = await boot({ dataDir, music: [] })
    await second.play()
    await sleep(2000)                                              // long enough for several saves

    const onDisk = readJson(statePath)
    assert.ok(onDisk, 'kaydedilen dosya geçerli JSON olmalı')
    assert.ok(onDisk.music.length >= 1, 'kurtarılan kütüphane diske geri yazılmalı, silinmemeli')
  })

  test('bozuk dosya silinmez, kenara alınır', async () => {
    // Even when recovery works, the damaged bytes are the only forensic evidence of what
    // happened. Overwriting them is throwing away the one thing that explains the incident.
    const first = await boot({ music: [makeTone(4, 300)] })
    const dataDir = first.dataDir
    await sleep(1500)
    await first.stop({ keepData: true })

    fs.writeFileSync(statePathOf(dataDir), '{"music": [ BOZUK')
    const second = await boot({ dataDir, music: [] })
    await second.api('/api/state')

    const kept = fs.readdirSync(dataDir).filter(name => name.includes('bozuk'))
    assert.ok(kept.length >= 1, `bozuk dosya saklanmalı, klasör: ${fs.readdirSync(dataDir).join(', ')}`)
    assert.match(fs.readFileSync(path.join(dataDir, kept[0]), 'utf8'), /BOZUK/)
  })

  test('operatör kurtarmadan haberdar edilir', async () => {
    // Silent recovery is how a station drifts: something was wrong, nobody knows, and the
    // next incident looks like the first one. The history card exists for exactly this.
    const first = await boot({ music: [makeTone(4, 700)] })
    const dataDir = first.dataDir
    await sleep(1500)
    await first.stop({ keepData: true })

    fs.writeFileSync(statePathOf(dataDir), 'bu JSON değil')
    const second = await boot({ dataDir, music: [] })
    const state = (await second.api('/api/state')).json

    // `yede[kğ]`, not `yedek`: Turkish softens the final k when a suffix follows, so the
    // message says "yedeği" and a literal search for "yedek" quietly finds nothing.
    const told = (state.history || []).some(entry => /yede[kğ]|kurtar/i.test(entry.title || ''))
    assert.ok(told, `günlükte kurtarma kaydı olmalı: ${JSON.stringify((state.history || []).slice(0, 3))}`)
  })

  test('hiç dosya yokken temiz kurulum gibi açılır', async () => {
    // The recovery path must not turn a genuine first run into an error report.
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rovli-fresh-'))
    fs.mkdirSync(path.join(dataDir, 'Music'), { recursive: true })
    fs.mkdirSync(path.join(dataDir, 'Ads'), { recursive: true })

    const station = await boot({ dataDir, music: [] })
    const state = (await station.api('/api/state')).json

    assert.equal(state.playback.status, 'stopped')
    const noise = (state.history || []).some(entry => /yedek|kurtar|bozuk/i.test(entry.title || ''))
    assert.equal(noise, false, 'ilk kurulumda kurtarma mesajı çıkmamalı')
  })

  test('yedek de bozuksa istasyon yine de açılır', async () => {
    // Two bad files in a row is unlikely but not impossible, and the station going down
    // entirely would be a worse outcome than starting empty.
    const first = await boot({ music: [makeTone(4, 800)] })
    const dataDir = first.dataDir
    await sleep(1500)
    await first.stop({ keepData: true })

    for (const name of fs.readdirSync(dataDir)) {
      if (name.startsWith('station.json')) fs.writeFileSync(path.join(dataDir, name), 'hepsi bozuk')
    }

    const second = await boot({ dataDir, music: [] })
    const response = await second.api('/api/state')
    assert.equal(response.status, 200, 'istasyon açılmalı')
  })
})
