// The panel has a card headed "Yayın Durumu" — Broadcast Status — showing a green line that
// reads "Yerel MP3 yayın motoru aktif." Both the flag and the sentence were hardcoded
// literals. They said the engine was running while the encoder was dead and the café was
// silent; during the pump deadlock fixed earlier in this project, that green line was on
// screen the entire time the station produced nothing.
//
// The engine already knows the truth — it timestamps every chunk the encoder emits, which is
// how the output watchdog decides to recycle it. The status card just never asked.

const test = require('node:test')
const assert = require('node:assert')
const { startServer, makeTone, waitFor, sleep } = require('../helpers/harness.cjs')

test('yayın akarken durum kartı akışı doğrular', async t => {
  const server = await startServer({ music: [makeTone(20, 440)] })
  t.after(() => server.stop())

  const meter = server.listen()
  t.after(() => meter.close())
  await waitFor(() => meter.status === 200, { label: '/live.mp3 bağlansın' })
  await server.play()
  await sleep(2000)

  const capabilities = (await server.state()).capabilities
  assert.equal(capabilities.flowing, true, 'sağlıklı yayında akış doğrulanmalı')
  assert.match(capabilities.message, /aktif/i)
})

test('tek bir kodlayıcı çökmesi paniğe dönüşmez', async t => {
  // Measured before writing this: an encoder killed on a healthy machine is respawned and
  // producing sound again in well under a second. That is the engine working, not a fault,
  // and a status card that flashed red on every hiccup would train the operator to ignore
  // it — which is how the hardcoded green line got away with lying for so long.
  //
  // The state this card exists to catch — a live encoder emitting nothing for many seconds —
  // is not reachable on demand from outside the process. It is covered deterministically in
  // tests/unit/broadcast-health.test.cjs, against health() itself.
  const server = await startServer({ music: [makeTone(20, 440)] })
  t.after(() => server.stop())

  const meter = server.listen()
  t.after(() => meter.close())
  await waitFor(() => meter.status === 200, { label: '/live.mp3 bağlansın' })
  await server.play()
  await sleep(2000)
  assert.equal((await server.state()).capabilities.flowing, true, 'hazırlık: önce sağlıklı olmalı')

  const encoder = await waitFor(() => server.encoder(), { label: 'kodlayıcı süreci' })
  process.kill(encoder.pid, 'SIGKILL')
  await sleep(3000)

  const capabilities = (await server.state()).capabilities
  assert.equal(capabilities.flowing, true, 'hızlı toparlanan çökme arıza olarak gösterilmemeli')
  assert.ok((await meter.sample(2000)) > 0, 've gerçekten ses akıyor olmalı')
})

test('kodlayıcı geri gelince kart da toparlar', async t => {
  // A status that latches to "broken" after one hiccup is the same failure in the other
  // direction — the operator stops believing it.
  const server = await startServer({ music: [makeTone(20, 440)] })
  t.after(() => server.stop())

  const meter = server.listen()
  t.after(() => meter.close())
  await waitFor(() => meter.status === 200, { label: '/live.mp3 bağlansın' })
  await server.play()
  await sleep(2000)

  const encoder = await waitFor(() => server.encoder(), { label: 'kodlayıcı süreci' })
  process.kill(encoder.pid, 'SIGKILL')

  const healthy = await waitFor(async () => (await server.state()).capabilities.flowing === true,
    { timeoutMs: 25000, label: 'yayın toparlasın' })
  assert.ok(healthy)
})
