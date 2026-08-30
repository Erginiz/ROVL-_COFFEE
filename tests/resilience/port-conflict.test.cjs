// Two copies of the station must never run at once. On Windows this is not hypothetical:
// measured before the fix, a second process bound the SAME port, logged that it had started
// successfully, and kept running — two stations, two encoders, and phones reaching whichever
// socket the OS happened to hand the connection to. From the café that looks like "sometimes
// it opens, sometimes it doesn't", which is exactly the kind of fault nobody can diagnose.
//
// The station must instead refuse to start, say why in words an operator can act on, and
// leave the running instance untouched.

const test = require('node:test')
const assert = require('node:assert')
const path = require('path')
const { spawn } = require('child_process')
const { startServer, makeTone, sleep } = require('../helpers/harness.cjs')

const SERVER = path.join(__dirname, '..', '..', 'server', 'index.cjs')

// Starts a second copy against the same port and reports what it did.
function startRival({ port, dataDir }) {
  return new Promise(resolve => {
    const proc = spawn(process.execPath, [SERVER], {
      env: { ...process.env, CAFE_RADIO_DATA: dataDir, PORT: String(port), HTTPS_PORT: String(port + 1000) },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    })
    let output = ''
    let exitCode = null
    proc.stdout.on('data', d => { output += d })
    proc.stderr.on('data', d => { output += d })
    proc.on('exit', code => { exitCode = code })
    setTimeout(() => resolve({
      get output() { return output },
      get exitCode() { return exitCode },
      kill: () => { try { proc.kill() } catch {} }
    }), 7000)
  })
}

test('ikinci kopya portu çalamaz ve temiz çıkar', { timeout: 180000 }, async t => {
  const server = await startServer({ music: [makeTone(10)] })
  t.after(() => server.stop())

  const rival = await startRival({ port: server.port, dataDir: server.dataDir })
  t.after(() => rival.kill())

  assert.notEqual(rival.exitCode, null, 'ikinci kopya çalışmaya devam etmemeli')
  assert.notEqual(rival.exitCode, 0, 'başarılı gibi sonlanmamalı')
})

test('çakışma operatörün anlayacağı dille bildirilir', { timeout: 180000 }, async t => {
  // "EADDRINUSE" means nothing to the person running a café. The message has to say what is
  // wrong and what to do about it.
  const server = await startServer({ music: [makeTone(10)] })
  t.after(() => server.stop())

  const rival = await startRival({ port: server.port, dataDir: server.dataDir })
  t.after(() => rival.kill())

  assert.match(rival.output, /zaten kullanımda/i, 'portun kullanımda olduğu söylenmeli')
  assert.match(rival.output, /başka bir kopyası|Görev Yöneticisi/i, 'ne yapılacağı söylenmeli')
})

test('çakışma çalışan istasyonu etkilemez', { timeout: 180000 }, async t => {
  // The running station is serving customers. A second launch must be a non-event for it.
  const server = await startServer({ music: [makeTone(20)] })
  t.after(() => server.stop())
  await server.play()

  const meter = server.listen()
  t.after(() => meter.close())
  await sleep(2000)
  const before = await meter.sample(2500)
  assert.ok(before > 0, 'önce ses akmalı')

  const rival = await startRival({ port: server.port, dataDir: server.dataDir })
  t.after(() => rival.kill())

  const state = await server.state()
  assert.ok(state.playback, 'çalışan istasyon yanıt vermeye devam etmeli')
  assert.ok((await meter.sample(3000)) > 5000, 'yayın kesilmemeli')
})
