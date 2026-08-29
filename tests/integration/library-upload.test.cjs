// The library is written from two directions at once: the upload endpoint and the folder
// scan that runs every 15 seconds. Both add entries, and the file lands on disk BEFORE the
// upload finishes probing it — so for a second or two the same file is visible to a scan
// that does not yet see a library entry for it.
//
// The result was a track listed twice, permanently: pruning keeps both copies because both
// point at a file that really exists, and deleting one removed the file while leaving the
// other behind. Reproduced on the first attempt, so it is not a theoretical race.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { startServer, makeTone, waitFor, sleep } = require('../helpers/harness.cjs')

const duplicates = names => names.filter((n, i) => names.indexOf(n) !== i)

test('yükleme ile tarama çakışsa da parça iki kez listelenmez', { timeout: 240000 }, async t => {
  const server = await startServer({ music: [] })
  t.after(() => server.stop())
  const content = fs.readFileSync(makeTone(8, 520))

  // Force the collision instead of hoping for it. A single upload racing a single scan is
  // timing-dependent and passed even against the broken code on a fast machine; several
  // uploads in flight while scans run back to back widens the window enough that both
  // orderings (scan-then-upload and upload-then-scan) happen on any machine.
  const FILES = 6
  const uploads = Array.from({ length: FILES }, (_, i) =>
    server.upload('/api/media/music', { filename: `race-${i}.mp3`, content }))
  const rescans = []
  for (let i = 0; i < 6; i++) {
    rescans.push(server.api('/api/rescan', 'POST').catch(() => null))
    await sleep(250)
  }
  const results = await Promise.all(uploads)
  await Promise.all(rescans)
  for (const [i, up] of results.entries()) assert.equal(up.status, 201, `${i}. yükleme başarılı olmalı`)

  // Settle, then let one more scan run so any duplicate has every chance to appear.
  await sleep(1000)
  await server.api('/api/rescan', 'POST')

  const names = (await server.state()).music.map(m => m.filename)
  assert.deepEqual(duplicates(names), [], `aynı dosya iki kez listelenmemeli: ${names.join(', ')}`)
  assert.equal(names.length, FILES, `her dosya tam olarak bir kez görünmeli (görülen: ${names.length})`)
})

test('yüklenen dosya silindiğinde arkada hayalet kayıt kalmaz', { timeout: 120000 }, async t => {
  // The duplicate's real cost: the operator deletes the track they can see, the file goes,
  // and a second entry stays in the list pointing at nothing.
  const server = await startServer({ music: [] })
  t.after(() => server.stop())

  const content = fs.readFileSync(makeTone(6, 440))
  const up = await server.upload('/api/media/music', { filename: 'silinecek.mp3', content })
  assert.equal(up.status, 201)
  await server.api('/api/rescan', 'POST')

  const before = (await server.state()).music
  const target = before.find(m => /silinecek/.test(m.filename))
  assert.ok(target, 'yüklenen dosya kütüphanede olmalı')

  const del = await server.api(`/api/media/music/${target.id}`, 'DELETE')
  assert.equal(del.status, 204)
  await server.api('/api/rescan', 'POST')
  await sleep(500)

  const after = (await server.state()).music
  assert.ok(!after.some(m => /silinecek/.test(m.filename)),
    'silinen parçadan geriye kayıt kalmamalı')
  assert.ok(!fs.existsSync(path.join(server.dataDir, 'Music', 'silinecek.mp3')) ||
    !fs.readdirSync(path.join(server.dataDir, 'Music')).some(f => /silinecek/.test(f)),
    'dosya diskten de silinmiş olmalı')
})

test('"Yenile" devam eden taramayı bekler ve yeni dosyaları getirir', { timeout: 120000 }, async t => {
  // /api/rescan used to no-op while a pass was already running and answer with a library
  // that still lacked the files the operator had just dropped — the button looked broken
  // for exactly the case it exists for.
  const server = await startServer({ music: [] })
  t.after(() => server.stop())

  // Drop files straight into the folder, the way "Klasörü Aç" invites the operator to.
  const tone = fs.readFileSync(makeTone(6, 300))
  for (let i = 0; i < 3; i++) {
    fs.writeFileSync(path.join(server.dataDir, 'Music', `elle-${i}.mp3`), tone)
  }

  const res = await server.api('/api/rescan', 'POST')
  assert.equal(res.status, 200)
  // The response itself must already reflect the new files — that is what the UI renders.
  const listed = res.json.music.filter(m => /^elle-/.test(m.filename))
  assert.equal(listed.length, 3, `elle atılan 3 dosya cevapta görünmeli (görülen: ${listed.length})`)
})

test('aynı dosya iki kez yüklenirse kütüphane tutarlı kalır', { timeout: 120000 }, async t => {
  // Uploads are named with a timestamp prefix, so two uploads of the same song are two
  // different files — both should be listed, each exactly once.
  const server = await startServer({ music: [] })
  t.after(() => server.stop())
  const content = fs.readFileSync(makeTone(6, 660))

  await server.upload('/api/media/music', { filename: 'ayni.mp3', content })
  await sleep(1100)   // the filename prefix has one-second resolution
  await server.upload('/api/media/music', { filename: 'ayni.mp3', content })
  await server.api('/api/rescan', 'POST')

  const names = (await server.state()).music.map(m => m.filename)
  assert.deepEqual(duplicates(names), [], 'hiçbir dosya adı iki kez listelenmemeli')
  assert.equal(names.length, 2, 'iki ayrı yükleme iki kayıt olmalı')

  // And every listed entry must correspond to a file that is really there.
  const onDisk = new Set(fs.readdirSync(path.join(server.dataDir, 'Music')))
  for (const name of names) assert.ok(onDisk.has(name), `${name} diskte bulunmalı`)
})
