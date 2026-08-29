// HTTPS is not decoration here: a phone needs a secure context to open its microphone, and
// the HTTPS page is where the operator types the admin code. Two properties carry that
// weight, and neither had a test:
//
//   1. The key is minted PER INSTALL. A key baked into the installer would be identical on
//      every machine, so anyone holding the installer could impersonate a station's page and
//      collect the code typed into it.
//   2. The certificate names the addresses phones actually use. Without the LAN IP in the
//      SAN, the browser adds a name-mismatch error on top of the self-signed warning, and
//      operators learn to click through warnings they should be reading.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const https = require('https')
const tls = require('tls')
const { startServer, makeTone, waitFor, lanIp } = require('../helpers/harness.cjs')

// The harness serves HTTPS on port + 1000 (see startServer).
const httpsPortOf = server => server.port + 1000

function httpsGet(port, pathname, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const req = https.get({ host, port, path: pathname, rejectUnauthorized: false }, res => {
      // Read the peer certificate NOW: by the time 'end' fires the socket has been released
      // and res.socket is null.
      const cert = res.socket?.getPeerCertificate?.() || null
      let body = ''
      res.on('data', c => { body += c })
      res.on('end', () => resolve({ status: res.statusCode, body, cert }))
    })
    req.on('error', reject)
    req.setTimeout(8000, () => req.destroy(new Error('https timeout')))
  })
}

async function waitForHttps(server) {
  return waitFor(async () => {
    try { return await httpsGet(httpsPortOf(server), '/api/state') } catch { return null }
  }, { timeoutMs: 40000, intervalMs: 500, label: 'HTTPS listener' })
}

test('HTTPS ayağa kalkar ve API’yi sunar', { timeout: 120000 }, async t => {
  const server = await startServer({ music: [makeTone(10)] })
  t.after(() => server.stop())

  const res = await waitForHttps(server)
  assert.equal(res.status, 200, 'durum bilgisi HTTPS üzerinden de gelmeli')
  const state = JSON.parse(res.body)
  assert.ok(state.playback, 'HTTPS cevabı geçerli durum döndürmeli')

  // The cert files must land in the writable data folder, not next to the program.
  assert.ok(fs.existsSync(path.join(server.dataDir, 'certs', 'key.pem')), 'anahtar veri klasöründe olmalı')
  assert.ok(fs.existsSync(path.join(server.dataDir, 'certs', 'cert.pem')), 'sertifika veri klasöründe olmalı')
})

test('sertifika telefonların kullandığı adresleri kapsar', { timeout: 120000 }, async t => {
  const server = await startServer({ music: [makeTone(10)] })
  t.after(() => server.stop())

  const res = await waitForHttps(server)
  const cert = res.cert
  assert.ok(cert && cert.subjectaltname, 'sertifikada subjectAltName olmalı')
  const san = cert.subjectaltname
  assert.match(san, /IP Address:127\.0\.0\.1/, 'localhost adresi kapsanmalı (kafe bilgisayarı)')
  assert.match(san, /DNS:localhost/, 'localhost adı kapsanmalı')

  const lan = lanIp()
  if (lan) {
    assert.ok(san.includes(lan),
      `LAN adresi (${lan}) sertifikada olmalı — yoksa telefon ad uyuşmazlığı uyarısı da alır: ${san}`)
  }

  // A ten-year certificate: the operator must not be locked out of the mic one day because
  // something silently expired.
  const notAfter = new Date(cert.valid_to).getTime()
  assert.ok(notAfter > Date.now() + 3 * 365 * 24 * 3600 * 1000, 'sertifika uzun ömürlü olmalı')
})

test('her kurulum kendi anahtarını üretir', { timeout: 120000 }, async t => {
  // The security claim in the code: keys are per-install. If two data folders produced the
  // same key, one installer would unlock every station's HTTPS identity.
  const a = await startServer({ music: [makeTone(6)] })
  t.after(() => a.stop())
  await waitForHttps(a)

  const b = await startServer({ music: [makeTone(6)] })
  t.after(() => b.stop())
  await waitForHttps(b)

  const keyA = fs.readFileSync(path.join(a.dataDir, 'certs', 'key.pem'), 'utf8')
  const keyB = fs.readFileSync(path.join(b.dataDir, 'certs', 'key.pem'), 'utf8')
  assert.notEqual(keyA, keyB, 'iki farklı kurulum aynı özel anahtarı kullanmamalı')
  assert.match(keyA, /BEGIN (RSA )?PRIVATE KEY/, 'geçerli bir özel anahtar yazılmalı')
})

test('var olan sertifika yeniden kullanılır (her açılışta yeni uyarı çıkmaz)', { timeout: 120000 }, async t => {
  // Regenerating on every boot would make the phone show a brand-new untrusted certificate
  // each morning, training the operator to accept whatever it shows them.
  const first = await startServer({ music: [makeTone(6)] })
  const dataDir = first.dataDir
  await waitForHttps(first)
  const keyBefore = fs.readFileSync(path.join(dataDir, 'certs', 'key.pem'), 'utf8')
  first.proc.kill('SIGKILL')
  await new Promise(r => setTimeout(r, 800))

  const second = await startServer({ music: [], dataDir })
  t.after(() => second.stop())
  await waitForHttps(second)
  const keyAfter = fs.readFileSync(path.join(dataDir, 'certs', 'key.pem'), 'utf8')
  assert.equal(keyAfter, keyBefore, 'yeniden başlatmada aynı sertifika kullanılmalı')
})

test('HTTPS üzerinden de yönetici koruması geçerli', { timeout: 120000 }, async t => {
  // The mic flow pushes phones onto HTTPS, so a hole there would be a hole in the one place
  // the operator is most likely to be typing the admin code.
  const server = await startServer({ music: [makeTone(10)] })
  t.after(() => server.stop())
  await waitForHttps(server)

  const lan = lanIp()
  if (!lan) return   // no LAN interface: the untrusted path cannot be exercised here

  const res = await new Promise((resolve, reject) => {
    const req = https.request({
      host: lan, port: httpsPortOf(server), path: '/api/control', method: 'POST',
      rejectUnauthorized: false, headers: { 'Content-Type': 'application/json' }
    }, r => { r.resume(); resolve({ status: r.statusCode }) })
    req.on('error', reject)
    req.setTimeout(8000, () => req.destroy(new Error('timeout')))
    req.write(JSON.stringify({ action: 'pause' }))
    req.end()
  })
  assert.equal(res.status, 403, 'HTTPS üzerinden de tokensiz kontrol reddedilmeli')
})
