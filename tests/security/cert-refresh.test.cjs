// A certificate only covers the addresses it was minted for. The café swapped its router,
// the PC moved to a new subnet, and the certificate kept naming an address the machine no
// longer had — so phones opening the announcement page (HTTPS, required for the microphone)
// got a NAME MISMATCH on top of the self-signed warning. Some mobile browsers will not let
// anyone past that at all: the page simply never opens.
//
// The station has to notice its own addresses changed and mint a new certificate.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const https = require('https')
const { startServer, makeTone, waitFor, lanIp } = require('../helpers/harness.cjs')

const LAN = lanIp()

function peerCert(port, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const req = https.get({ host, port, path: '/api/state', rejectUnauthorized: false }, res => {
      const cert = res.socket?.getPeerCertificate?.() || null
      res.resume()
      resolve(cert)
    })
    req.on('error', reject)
    req.setTimeout(8000, () => req.destroy(new Error('timeout')))
  })
}
const waitForCert = server => waitFor(async () => {
  try { return await peerCert(server.port + 1000) } catch { return null }
}, { timeoutMs: 40000, intervalMs: 500, label: 'HTTPS hazır' })

test('adresler değişince sertifika yenilenir', { skip: LAN ? false : 'LAN yok', timeout: 180000 }, async t => {
  // First boot mints a certificate for whatever the machine has now.
  const first = await startServer({ music: [makeTone(6)] })
  const dataDir = first.dataDir
  const original = await waitForCert(first)
  assert.ok(original.subjectaltname.includes(LAN), 'ilk sertifika mevcut adresi kapsamalı')
  const originalKey = fs.readFileSync(path.join(dataDir, 'certs', 'key.pem'), 'utf8')
  first.proc.kill('SIGKILL')
  await new Promise(r => setTimeout(r, 800))

  // Simulate the router swap: replace the stored certificate with one that names only an
  // address this machine does not have. That is exactly what an old certificate looks like
  // after the subnet changes.
  const stale = await mintStaleCert(dataDir)
  assert.ok(!stale.includes(LAN), 'kurgu sertifika mevcut adresi kapsamamalı')

  const second = await startServer({ music: [], dataDir })
  t.after(() => second.stop())
  const renewed = await waitForCert(second)

  assert.ok(renewed.subjectaltname.includes(LAN),
    `yenilenen sertifika mevcut adresi kapsamalı: ${renewed.subjectaltname}`)
  const newKey = fs.readFileSync(path.join(dataDir, 'certs', 'key.pem'), 'utf8')
  assert.notEqual(newKey, originalKey, 'gerçekten yeni bir anahtar üretilmeli')
})

test('adresler aynıysa sertifika gereksiz yere yenilenmez', { timeout: 180000 }, async t => {
  // Regenerating on every boot would show the phone a brand-new untrusted certificate each
  // morning, which trains the operator to accept whatever warning appears.
  const first = await startServer({ music: [makeTone(6)] })
  const dataDir = first.dataDir
  await waitForCert(first)
  const keyBefore = fs.readFileSync(path.join(dataDir, 'certs', 'key.pem'), 'utf8')
  first.proc.kill('SIGKILL')
  await new Promise(r => setTimeout(r, 800))

  const second = await startServer({ music: [], dataDir })
  t.after(() => second.stop())
  await waitForCert(second)
  const keyAfter = fs.readFileSync(path.join(dataDir, 'certs', 'key.pem'), 'utf8')
  assert.equal(keyAfter, keyBefore, 'adres değişmediyse aynı sertifika kullanılmalı')
})

test('okunamayan sertifika açılışı engellemez', { timeout: 180000 }, async t => {
  // A truncated or corrupted certificate file must not stop the station: the café loses its
  // music over a file that only exists to make the microphone work.
  const first = await startServer({ music: [makeTone(6)] })
  const dataDir = first.dataDir
  await waitForCert(first)
  first.proc.kill('SIGKILL')
  await new Promise(r => setTimeout(r, 800))
  fs.writeFileSync(path.join(dataDir, 'certs', 'cert.pem'), 'bu bir sertifika degil')

  const second = await startServer({ music: [], dataDir })
  t.after(() => second.stop())

  const state = await second.state()
  assert.ok(state.playback, 'bozuk sertifikaya rağmen istasyon çalışmalı')
  await second.play()
  const meter = second.listen()
  t.after(() => meter.close())
  await waitFor(() => meter.status === 200, { label: '/live.mp3' })
  assert.ok((await meter.sample(3000)) > 5000, 'yayın akmalı')
})

// Writes a certificate that names only an unrelated address, standing in for one minted
// before the café changed routers.
async function mintStaleCert(dataDir) {
  const selfsigned = require(path.join(__dirname, '..', '..', 'node_modules', 'selfsigned'))
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'Rovli Radyo' }], {
    keySize: 2048,
    algorithm: 'sha256',
    notAfterDate: new Date(Date.now() + 365 * 24 * 3600 * 1000),
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '10.55.55.55' }] }
    ]
  })
  fs.writeFileSync(path.join(dataDir, 'certs', 'key.pem'), pems.private)
  fs.writeFileSync(path.join(dataDir, 'certs', 'cert.pem'), pems.cert)
  return pems.cert
}
