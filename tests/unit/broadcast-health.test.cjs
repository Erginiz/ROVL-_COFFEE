// `health()` is what the panel's "Yayın Durumu" card now reports instead of a hardcoded
// sentence. The failure it exists to name is the one that actually hurt this project: an
// encoder process that is alive and looks fine to every other check, while producing no
// output at all. That is what the pump deadlock did, and for as long as it lasted the panel
// showed a green "aktif" line.
//
// Tested here rather than against a running station because the interesting states are not
// reachable on demand from outside: a real encoder killed on a healthy machine is back in
// under a second, which is the engine recovering correctly, not the fault being described.

const test = require('node:test')
const assert = require('node:assert')
const { AudioEngine } = require('../../server/audio-engine.cjs')

// Nothing here starts ffmpeg — health() reads two fields and does not touch the process.
function engineWith({ encoder, sinceOutputMs, shuttingDown = false }) {
  const engine = Object.create(AudioEngine.prototype)
  engine.encoder = encoder
  engine.shuttingDown = shuttingDown
  engine.lastEncoderOutputAt = Date.now() - sinceOutputMs
  return engine
}
const fakeEncoder = { pid: 1234 }

test('çıkış akarken sağlıklı bildirilir', () => {
  const health = engineWith({ encoder: fakeEncoder, sinceOutputMs: 100 }).health()
  assert.equal(health.flowing, true)
  assert.equal(health.encoderRunning, true)
})

test('kodlayıcı ayakta ama çıkış yoksa sağlıklı sayılmaz', () => {
  // THE case. Every other signal says the engine is fine; the speakers say otherwise.
  const health = engineWith({ encoder: fakeEncoder, sinceOutputMs: 20000 }).health()
  assert.equal(health.flowing, false, 'süreç yaşıyor diye akıyor sayılmamalı')
  assert.equal(health.encoderRunning, true, 'süreç gerçekten ayakta — bu ayrı bir bilgi')
})

test('kodlayıcı hiç yokken sağlıklı sayılmaz', () => {
  const health = engineWith({ encoder: null, sinceOutputMs: 100 }).health()
  assert.equal(health.flowing, false)
  assert.equal(health.encoderRunning, false)
})

test('kapanış sırasında sağlıklı sayılmaz', () => {
  // A station being shut down produces no sound, and reporting that as a fault would put a
  // red line on screen every time the operator closes the app.
  const health = engineWith({ encoder: fakeEncoder, sinceOutputMs: 100, shuttingDown: true }).health()
  assert.equal(health.flowing, false)
})

test('kısa duraksamalar arıza sayılmaz', () => {
  // The watchdog tolerates 8 seconds before recycling the encoder; the status card must use
  // the same threshold, or it would cry wolf at every scheduling hiccup on a busy PC.
  const health = engineWith({ encoder: fakeEncoder, sinceOutputMs: 5000 }).health()
  assert.equal(health.flowing, true, '5 sn duraksama nöbetçinin eşiğinin altında')
})

test('kesintinin ne kadar sürdüğü de bildirilir', () => {
  // "Broken" is not actionable on its own; how long it has been broken is.
  const health = engineWith({ encoder: fakeEncoder, sinceOutputMs: 12000 }).health()
  assert.ok(health.sinceOutputMs >= 12000 && health.sinceOutputMs < 13000,
    `süre gerçekçi olmalı, gelen: ${health.sinceOutputMs}`)
})
