// Prayer times come from a public API over the café's internet connection — the one part of
// this app that depends on something outside the building. When that connection is down (or
// the address is simply wrong), the station used to re-request every 20 seconds, for ever:
// thousands of failed calls a day against a service nobody is paying for, which is how an
// address gets blocked — and then the feature stays broken even after the internet returns.
//
// A fake API stands in for the real one (EZAN_API_URL), so these tests measure the retry
// behaviour itself without touching the network or depending on someone else's uptime.

const test = require('node:test')
const assert = require('node:assert')
const http = require('http')
const { startServer, makeTone, waitFor, sleep } = require('../helpers/harness.cjs')

// A stand-in for api.aladhan.com that counts calls and can be told to fail or succeed.
function fakePrayerApi({ failing = true } = {}) {
  const api = { calls: 0, failing }
  api.server = http.createServer((req, res) => {
    api.calls++
    if (api.failing) { res.writeHead(500); res.end('nope'); return }
    // The shape the client reads: data.timings with the five prayers.
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ data: { timings: { Fajr: '04:30', Dhuhr: '13:00', Asr: '17:00', Maghrib: '20:00', Isha: '21:30' } } }))
  })
  api.start = () => new Promise(resolve => api.server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${api.server.address().port}/timings`)))
  api.stop = () => new Promise(resolve => api.server.close(resolve))
  return api
}

test('vakitler alınamayınca istek yağmuru olmaz', { timeout: 180000 }, async t => {
  const api = fakePrayerApi({ failing: true })
  const url = await api.start()
  t.after(() => api.stop())

  const server = await startServer({ music: [makeTone(10)], env: { EZAN_API_URL: url } })
  t.after(() => server.stop())

  // Turn the feature on: the station now wants times it cannot get.
  await server.api('/api/settings', 'PATCH', { ezan: { enabled: true, il: 'İstanbul' } })
  await waitFor(() => api.calls >= 1, { timeoutMs: 20000, label: 'ilk deneme' })

  // The tick runs every 20s. Without a backoff this window would produce several calls;
  // with one, the first failure buys at least a minute of quiet.
  const afterFirst = api.calls
  await sleep(45000)
  const during = api.calls - afterFirst
  assert.ok(during === 0, `başarısızlıktan sonra hemen tekrar denenmemeli (45sn içinde ${during} istek daha)`)

  // The operator still has to be told what went wrong.
  const state = await server.state()
  assert.ok(state.ezan.lastError, 'hata operatöre gösterilmeli')
})

test('operatör ayarı değiştirince beklemeden yeniden denenir', { timeout: 180000 }, async t => {
  // Backing off is right for the automatic retry, but an operator who just fixed the Wi-Fi
  // and pressed something must not be told to wait out a window they cannot even see.
  const api = fakePrayerApi({ failing: true })
  const url = await api.start()
  t.after(() => api.stop())

  const server = await startServer({ music: [makeTone(10)], env: { EZAN_API_URL: url } })
  t.after(() => server.stop())

  await server.api('/api/settings', 'PATCH', { ezan: { enabled: true, il: 'İstanbul' } })
  await waitFor(() => api.calls >= 1, { timeoutMs: 20000, label: 'ilk deneme' })
  const afterFail = api.calls

  // The connection comes back and the operator picks their city again.
  api.failing = false
  await server.api('/api/settings', 'PATCH', { ezan: { il: 'Ankara' } })

  await waitFor(() => api.calls > afterFail, { timeoutMs: 20000, intervalMs: 250, label: 'ayar değişince yeni deneme' })
  const state = await waitFor(async () => {
    const s = await server.state()
    return Object.keys(s.ezan.times || {}).length ? s : null
  }, { timeoutMs: 20000, intervalMs: 250, label: 'vakitler geldi' })

  assert.ok(state.ezan.times['Öğle'], 'vakitler alınmalı')
  assert.equal(state.ezan.lastError, null, 'başarıdan sonra hata temizlenmeli')
})

test('vakitler alınınca tekrar tekrar istenmez', { timeout: 120000 }, async t => {
  // Once a day's times are in hand the tick must stop calling out entirely — the schedule
  // is only refetched when the date rolls over or the location changes.
  const api = fakePrayerApi({ failing: false })
  const url = await api.start()
  t.after(() => api.stop())

  const server = await startServer({ music: [makeTone(10)], env: { EZAN_API_URL: url } })
  t.after(() => server.stop())

  await server.api('/api/settings', 'PATCH', { ezan: { enabled: true, il: 'İstanbul' } })
  await waitFor(async () => Object.keys((await server.state()).ezan.times || {}).length > 0,
    { timeoutMs: 20000, label: 'vakitler alındı' })

  const afterSuccess = api.calls
  await sleep(45000)   // more than two ticks
  assert.equal(api.calls, afterSuccess, `vakitler elde varken tekrar istenmemeli (${api.calls - afterSuccess} fazladan istek)`)
})
