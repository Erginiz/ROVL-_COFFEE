const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { stationModel, deferred } = require('../helpers/station-model.cjs')

test('a completed upload survives a scan that listed the folder earlier', async t => {
  const { c, write, call } = stationModel(t)
  const entered = deferred(); const release = deferred()
  write('music', 'old.mp3')
  c.probeLoudness = async file => {
    if (file.endsWith('old.mp3')) { entered.resolve(); await release.promise }
    return 0
  }
  const scan = c.scanLibrary()
  await entered.promise
  const uploadedPath = write('incoming', 'new.mp3')
  const up = await call('post', '/api/media/:kind', { params: { kind: 'music' }, file: { path: uploadedPath, filename: 'new.mp3', originalname: 'new.mp3' } })
  assert.equal(up.statusCode, 201)
  const uploadedId = up.body.id
  release.resolve(); await scan
  assert.ok(c.state.music.some(item => item.id === uploadedId), 'original uploaded id must survive without a repair scan')
  assert.ok(fs.existsSync(path.join(c.mediaRoots.music, 'new.mp3')))
  assert.equal(c.state.music.length, 2)
})

test('an upload is invisible until probing finishes and publishes only once', async t => {
  const { c, write, call } = stationModel(t)
  const entered = deferred(); const release = deferred()
  c.probeLoudness = async () => { entered.resolve(); await release.promise; return 4 }
  const file = write('incoming', 'pending.mp3')
  const uploading = call('post', '/api/media/:kind', { params: { kind: 'music' }, file: { path: file, filename: 'pending.mp3', originalname: 'pending.mp3' } })
  await entered.promise
  await c.scanLibrary()
  assert.equal(c.state.music.length, 0)
  release.resolve(); const up = await uploading
  await c.scanLibrary()
  assert.equal(c.state.music.length, 1)
  assert.equal(c.state.music[0].id, up.body.id)
  assert.equal(fs.existsSync(file), false)
})

test('delete permission failure preserves disk, library and queue and reports failure', async t => {
  const { c, write, call } = stationModel(t)
  const file = write('music', 'locked.mp3'); await c.scanLibrary()
  const item = c.state.music[0]; c.state.queues.music = [item.id]
  c.fs.unlinkSync = () => { throw Object.assign(new Error('access denied'), { code: 'EACCES' }) }
  const res = await call('delete', '/api/media/:kind/:id', { params: { kind: 'music', id: item.id } })
  assert.equal(res.statusCode, 500)
  assert.match(res.body.error, /silinemedi/)
  assert.equal(c.state.music[0].id, item.id)
  assert.deepEqual(c.state.queues.music, [item.id])
  assert.ok(fs.existsSync(file))
})

test('a missing file can be deleted idempotently without returning an error', async t => {
  const { c, write, call } = stationModel(t)
  const file = write('music', 'gone.mp3'); await c.scanLibrary()
  const item = c.state.music[0]; fs.unlinkSync(file)
  const res = await call('delete', '/api/media/:kind/:id', { params: { kind: 'music', id: item.id } })
  assert.equal(res.statusCode, 204)
  assert.equal(c.state.music.length, 0)
})

test('missing folder reports 503 once and preserves its library until recovery', async t => {
  const { c, write, call } = stationModel(t)
  write('music', 'saved.mp3'); await c.scanLibrary()
  const id = c.state.music[0].id
  const moved = c.mediaRoots.music + '-away'; fs.renameSync(c.mediaRoots.music, moved)
  for (let i = 0; i < 2; i++) {
    const res = await call('post', '/api/rescan')
    assert.equal(res.statusCode, 503)
    assert.match(res.body.error, /taranamadı/)
    assert.equal(c.state.music[0].id, id)
  }
  assert.equal(c.state.history.filter(h => /taranamıyor/.test(h.title)).length, 1)
  fs.renameSync(moved, c.mediaRoots.music)
  assert.equal((await call('post', '/api/rescan')).statusCode, 200)
  assert.ok(c.state.history.some(h => /yeniden taranabiliyor/.test(h.title)))
})

test('replacing a same-name file refreshes duration, tags and gain while retaining id', async t => {
  const { c, write } = stationModel(t)
  write('music', 'replace.mp3', { title: 'Old', durationSeconds: 60, gainDb: 12 })
  await c.scanLibrary(); const id = c.state.music[0].id
  write('music', 'replace.mp3', { title: 'New replacement', durationSeconds: 320, gainDb: -9 })
  await c.scanLibrary()
  assert.equal(c.state.music[0].id, id)
  assert.equal(c.state.music[0].title, 'New replacement')
  assert.equal(c.state.music[0].durationSeconds, 320)
  assert.equal(c.state.music[0].gainDb, -9)
})

test('a file replaced during analysis never receives the old version gain', async t => {
  const { c, write } = stationModel(t)
  const entered = deferred(); const release = deferred()
  write('music', 'replace.mp3', { gainDb: 12 })
  c.probeLoudness = async () => { entered.resolve(); await release.promise; return 12 }
  const scan = c.scanLibrary(); await entered.promise
  write('music', 'replace.mp3', { title: 'Replacement', gainDb: -9 })
  release.resolve(); await scan
  assert.notEqual(c.state.music[0].gainDb, 12)
  c.probeLoudness = async () => -9; await c.scanLibrary()
  assert.equal(c.state.music[0].gainDb, -9)
})
