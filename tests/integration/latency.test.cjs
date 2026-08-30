// The panel tells the operator "Hedef gecikme: yaklaşık 2 sn". That number is a hardcoded
// constant, not a measurement — nothing in the project ever checked whether the engine is
// anywhere near it. A buffering change, a larger chunk size, or an extra queue in the mixer
// could push the real figure to five seconds and every test would still pass while the
// operator presses "next" and waits.
//
// Measured the way it is actually felt: issue a command, then find in the stream itself the
// moment the sound changes. Two tones an octave apart make the switch unmistakable.

const test = require('node:test')
const assert = require('node:assert')
const { startServer, makeTone, sleep } = require('../helpers/harness.cjs')
const { captureStream, decodeToPcm, dominantFrequency } = require('../helpers/audio-analysis.cjs')

const SAMPLE_RATE = 48000
const WINDOW_MS = 100

// Walks the decoded capture in short windows and reports when the tone first crosses over.
function firstMomentAbove(pcm, hz) {
  const window = Math.floor(SAMPLE_RATE * (WINDOW_MS / 1000))
  for (let offset = 0; offset + window <= pcm.length; offset += window) {
    if (dominantFrequency(pcm.subarray(offset, offset + window), SAMPLE_RATE) > hz) {
      return (offset / SAMPLE_RATE) * 1000
    }
  }
  return null
}

test('komuttan sese kadar geçen süre saniyenin altında kalır', async t => {
  const server = await startServer({ music: [makeTone(25, 440), makeTone(25, 880)] })
  t.after(() => server.stop())

  await server.api('/api/settings', 'PATCH', { playback: { shuffle: false } })
  await server.play()
  await sleep(4000)                                  // let the low tone settle in the stream

  const started = Date.now()
  const capture = captureStream(server.port, 8)
  await sleep(2500)
  const commandAt = Date.now() - started
  await server.api('/api/control', 'POST', { action: 'next' })

  const pcm = decodeToPcm(await capture, { skipSeconds: 0 })
  const heardAt = firstMomentAbove(pcm, 700)
  assert.ok(heardAt !== null, 'yüksek ton akışta hiç duyulmadı — geçiş olmamış')

  const latency = heardAt - commandAt
  // Measured at ~700 ms on a development PC. The bound sits at roughly double that: loose
  // enough to survive a busy machine, tight enough to actually catch something. A first
  // attempt at 2500 ms was useless — 1.5 s of artificial buffering injected into the engine
  // still passed it. At 1500 ms that same mutation turns the test red.
  assert.ok(latency > 0, `ton komuttan ÖNCE duyuldu (${Math.round(latency)} ms) — ölçüm hatalı`)
  assert.ok(latency < 1500, `komuttan sese ${Math.round(latency)} ms — motorda tampon şişmiş olabilir`)
})

test('panelde yazan hedef gecikme ölçülenden düşük olmamalı', async t => {
  // The number on screen is a promise to the operator. It may be conservative — the phone
  // adds its own buffer on top — but it must not be smaller than what the server alone does,
  // or the panel is claiming something the engine cannot deliver.
  const server = await startServer({ music: [makeTone(20, 440)] })
  t.after(() => server.stop())

  const claimed = (await server.state()).timing.targetLatencySeconds
  assert.ok(Number.isFinite(claimed) && claimed > 0, `hedef gecikme sayı olmalı, gelen: ${claimed}`)
  assert.ok(claimed >= 0.7, `panel ${claimed} sn diyor; sunucu tarafı tek başına bunun üstünde`)
})
