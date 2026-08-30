// The admin boundary is the one place in this app where a bug is not merely annoying:
// everyone in the café is on the same Wi-Fi as the station, so "reachable" is the default
// and every control endpoint is one unauthenticated request away from a customer.
//
// The trust model under test:
//   127.0.0.1  → the café's own PC (Electron). Trusted, no code needed.
//   LAN address → an untrusted phone. Needs a token earned by typing the 6-digit code.
//   Listener endpoints (state, live.mp3, heartbeat) stay open to everyone.
//
// These tests must arrive over the LAN interface — hitting 127.0.0.1 takes the bypass and
// would pass no matter how broken the auth is.

const test = require('node:test')
const assert = require('node:assert')
const { startServer, makeTone, lanIp, sleep } = require('../helpers/harness.cjs')

const LAN = lanIp()
const skip = LAN ? false : 'bu makinede LAN adresi yok (auth yolu test edilemez)'

// The desk PC is allowed to read the current code off its own screen; tests do the same.
async function adminCode(server) {
  const res = await server.api('/api/admin/code')
  assert.equal(res.status, 200, 'kod localhost’tan okunabilmeli')
  return res.json.code
}

test('yönetici yetkilendirme matrisi', { skip, timeout: 120000 }, async t => {
  const server = await startServer({ music: [makeTone(10)] })
  t.after(() => server.stop())
  const code = await adminCode(server)

  await t.test('kafe bilgisayarı koda ihtiyaç duymaz', async () => {
    const res = await server.api('/api/control', 'POST', { action: 'pause' })
    assert.equal(res.status, 200)
  })

  await t.test('LAN’dan tokensiz kontrol reddedilir', async () => {
    const res = await server.api('/api/control', 'POST', { action: 'pause' }, {}, LAN)
    assert.equal(res.status, 403, 'telefon giriş yapmadan yayını yönetememeli')
  })

  await t.test('uydurma token reddedilir', async () => {
    const res = await server.api('/api/control', 'POST', { action: 'pause' },
      { 'x-admin-token': 'a'.repeat(48) }, LAN)
    assert.equal(res.status, 403)
  })

  await t.test('yanlış kod token vermez', async () => {
    const res = await server.api('/api/admin/login', 'POST', { code: '000000' }, {}, LAN)
    assert.equal(res.status, 403)
    assert.ok(!res.json?.token, 'başarısız giriş token döndürmemeli')
  })

  await t.test('doğru kod token verir ve token kontrolü açar', async () => {
    const login = await server.api('/api/admin/login', 'POST', { code }, {}, LAN)
    assert.equal(login.status, 200)
    const token = login.json.token
    assert.ok(token && token.length >= 32, 'token yeterince uzun olmalı')

    const res = await server.api('/api/control', 'POST', { action: 'pause' },
      { 'x-admin-token': token }, LAN)
    assert.equal(res.status, 200, 'giriş yapmış telefon yayını yönetebilmeli')
  })

  await t.test('kod cevapta asla geri dönmez', async () => {
    const login = await server.api('/api/admin/login', 'POST', { code }, {}, LAN)
    assert.ok(!login.body.includes(code), 'giriş cevabı kodun kendisini içermemeli')
    const state = await server.api('/api/state', 'GET', null, {}, LAN)
    assert.ok(!state.body.includes(code), 'yayın durumu her dinleyiciye gider — kod içinde olmamalı')
  })

  await t.test('çıkış yapınca token ölür', async () => {
    const { json: { token } } = await server.api('/api/admin/login', 'POST', { code }, {}, LAN)
    await server.api('/api/admin/logout', 'POST', null, { 'x-admin-token': token }, LAN)
    const res = await server.api('/api/control', 'POST', { action: 'pause' },
      { 'x-admin-token': token }, LAN)
    assert.equal(res.status, 403, 'çıkıştan sonra token kullanılamamalı')
  })
})

test('kodun kendisi yalnızca kafe bilgisayarına aittir', { skip, timeout: 120000 }, async t => {
  const server = await startServer({ music: [makeTone(10)] })
  t.after(() => server.stop())
  const code = await adminCode(server)
  const { json: { token } } = await server.api('/api/admin/login', 'POST', { code }, {}, LAN)

  // A phone may control the station, but it must never be able to READ the code or mint a
  // new one — that would let one unlocked phone hand permanent access to anyone.
  const read = await server.api('/api/admin/code', 'GET', null, { 'x-admin-token': token }, LAN)
  assert.equal(read.status, 403, 'giriş yapmış telefon bile kodu okuyamamalı')
  const rotate = await server.api('/api/admin/rotate', 'POST', null, { 'x-admin-token': token }, LAN)
  assert.equal(rotate.status, 403, 'telefon yeni kod üretememeli')
})

test('kod yenilenince tüm telefonların oturumu düşer', { skip, timeout: 120000 }, async t => {
  const server = await startServer({ music: [makeTone(10)] })
  t.after(() => server.stop())
  const code = await adminCode(server)
  const { json: { token } } = await server.api('/api/admin/login', 'POST', { code }, {}, LAN)
  assert.equal((await server.api('/api/control', 'POST', { action: 'pause' }, { 'x-admin-token': token }, LAN)).status, 200)

  const rotated = await server.api('/api/admin/rotate', 'POST')   // from the café PC
  assert.equal(rotated.status, 200)
  assert.notEqual(rotated.json.code, code, 'yeni kod eskisinden farklı olmalı')

  // This is the operator's "kick everyone out" button; if old tokens survived it, a phone
  // that had been unlocked once could never be revoked.
  const res = await server.api('/api/control', 'POST', { action: 'pause' }, { 'x-admin-token': token }, LAN)
  assert.equal(res.status, 403, 'eski token kod yenilendikten sonra geçersiz olmalı')
})

test('kaba kuvvet denemesi kilitlenir', { skip, timeout: 120000 }, async t => {
  // A 6-digit code is a million guesses; a script on the café Wi-Fi walks that in minutes
  // unless wrong answers get slower. Gets its own server so the lock can't leak into
  // another test's IP record.
  const server = await startServer({ music: [makeTone(10)] })
  t.after(() => server.stop())
  const code = await adminCode(server)

  let lockedAt = 0
  for (let attempt = 1; attempt <= 6; attempt++) {
    const res = await server.api('/api/admin/login', 'POST', { code: '111111' }, {}, LAN)
    if (res.status === 429) { lockedAt = attempt; break }
    assert.equal(res.status, 403, `${attempt}. yanlış deneme reddedilmeli`)
  }
  assert.ok(lockedAt > 0 && lockedAt <= 6, `kilit birkaç denemede devreye girmeli (girdiği deneme: ${lockedAt})`)

  // Crucially the lock must hold even for the RIGHT code — otherwise an attacker who
  // stumbles on the answer during the lockout still gets in.
  const correct = await server.api('/api/admin/login', 'POST', { code }, {}, LAN)
  assert.equal(correct.status, 429, 'kilit sırasında doğru kod bile kabul edilmemeli')

  // The café PC must not be collateral damage: the operator still has to be able to work.
  assert.equal((await server.api('/api/control', 'POST', { action: 'pause' })).status, 200,
    'kilit kafe bilgisayarını etkilememeli')
})

test('dinleyici uçları herkese açık kalır', { skip, timeout: 120000 }, async t => {
  // The guest experience must not need a code: scanning the QR has to just work.
  const server = await startServer({ music: [makeTone(10)] })
  t.after(() => server.stop())

  assert.equal((await server.api('/api/state', 'GET', null, {}, LAN)).status, 200, 'yayın durumu açık olmalı')
  assert.equal((await server.api('/api/listeners/heartbeat', 'POST', { id: 'test-phone' }, {}, LAN)).status, 204,
    'dinleyici kalp atışı açık olmalı')
  const stream = await new Promise(resolve => {
    const req = require('http').get({ host: LAN, port: server.port, path: '/live.mp3' }, res => {
      res.destroy(); resolve(res.statusCode)
    })
    req.on('error', () => resolve(0))
  })
  assert.equal(stream, 200, 'canlı yayın telefonlara açık olmalı')
})

test('müzik dosyaları LAN’dan indirilemez', { skip, timeout: 120000 }, async t => {
  // /media serves the raw library. Nothing in the listener UI uses it, and leaving it open
  // lets any customer enumerate and download the café's whole music collection.
  const server = await startServer({ music: [makeTone(10)] })
  t.after(() => server.stop())

  const open = await server.api('/media/music/track-0.mp3', 'GET', null, {}, LAN)
  assert.equal(open.status, 403, 'kütüphane dosyaları tokensiz indirilememeli')

  const code = await adminCode(server)
  const { json: { token } } = await server.api('/api/admin/login', 'POST', { code }, {}, LAN)
  const allowed = await server.api('/media/music/track-0.mp3', 'GET', null, { 'x-admin-token': token }, LAN)
  assert.equal(allowed.status, 200, 'yönetici erişebilmeli')
})

test('başka bir siteden gelen yazma isteği reddedilir (CSRF)', { skip, timeout: 120000 }, async t => {
  // A page open in any browser on this network can POST to the station's address. Without
  // an origin check, a customer's phone browsing a malicious page could control the music.
  const server = await startServer({ music: [makeTone(10)] })
  t.after(() => server.stop())

  const foreign = await server.api('/api/control', 'POST', { action: 'pause' },
    { Origin: 'http://evil.example.com' })
  assert.equal(foreign.status, 403, 'yabancı origin’den yazma reddedilmeli')

  const own = await server.api('/api/control', 'POST', { action: 'pause' },
    { Origin: `http://127.0.0.1:${server.port}` })
  assert.equal(own.status, 200, 'kendi sayfamızdan gelen istek geçmeli')

  // Electron and curl send no Origin at all; blocking those would break the desk app.
  assert.equal((await server.api('/api/control', 'POST', { action: 'pause' })).status, 200)
})

test('ses olmayan dosya yüklenemez (uzantı mimetype’a rağmen)', { skip: false, timeout: 120000 }, async t => {
  // The media folders are served over HTTP, so what lands there matters. The mimetype is
  // supplied by the uploader and can lie; the extension is what decides whether the saved
  // file is executable, so both have to pass.
  const server = await startServer({ music: [makeTone(10)] })
  t.after(() => server.stop())

  const evil = await server.upload('/api/media/music',
    { filename: 'payload.exe', content: 'MZ fake executable', mimetype: 'audio/mpeg' })
  assert.equal(evil.status, 400, 'ses gibi etiketlenmiş .exe reddedilmeli')

  const fs = require('fs'), path = require('path')
  const landed = fs.readdirSync(path.join(server.dataDir, 'Music'))
  assert.ok(!landed.some(f => f.endsWith('.exe')), 'reddedilen dosya diske yazılmamalı')
})

// Measured against the running station before this was written: lock one address out with
// five wrong codes, then log in from a different address and the very first attempt is
// answered normally. Changing source address is free — an IPv6 privacy extension does it
// unprompted — so the per-address counter never bounded the guess rate. With the source
// public, an attacker walking a six-digit space at HTTP speed is hours, not months.
test('adres değiştirerek kilit atlanabiliyordu — artık toplam deneme sayılıyor', { skip, timeout: 400000 }, async t => {
  const server = await startServer({ music: [] })
  t.after(() => server.stop())

  // Two distinct keys are all this machine offers: every 127.x address is reported as one
  // address by Windows, and the LAN address is the second. So the attack is played out the
  // way a real one would be — wait out each address lock and come back — rather than faked.
  const lan = LAN
  const attempt = host => server.raw('/api/admin/login', 'POST',
    JSON.stringify({ code: '000000' }), { 'content-type': 'application/json' }, host)

  // Half a dozen rounds of five, alternating addresses and waiting out the per-address lock.
  let sawGlobalStop = false
  for (let round = 0; round < 4 && !sawGlobalStop; round++) {
    for (const host of ['127.0.0.1', lan]) {
      for (let i = 0; i < 5; i++) {
        const res = await attempt(host)
        if (res.status === 429 && /birkaç dakika/i.test(res.body || '')) { sawGlobalStop = true; break }
      }
      if (sawGlobalStop) break
    }
    if (!sawGlobalStop) await sleep(61000)      // adres kilidinin dolmasını bekle
  }

  assert.ok(sawGlobalStop, 'yeterince hatalı denemeden sonra tüm girişler durdurulmalı')

  // And it must reach the operator: a burst of failed logins on the café Wi-Fi is worth
  // knowing about, once.
  const history = (await server.state()).history
  const notices = history.filter(entry => /hatalı yönetici kodu/i.test(entry.title || ''))
  assert.ok(notices.length >= 1, `operatör uyarılmalı: ${JSON.stringify(history.slice(0, 3))}`)
  assert.ok(notices.length <= 2, `${notices.length} kez yazılmış — saldırı günlüğü doldurmamalı`)
})
