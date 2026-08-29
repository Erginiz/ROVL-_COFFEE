// The soft limiter is what stands between per-track normalisation and the crackle the café
// has complained about before. Loudness normalisation multiplies quiet files UP, and the
// operator can push a level past 100%, so samples routinely arrive above full scale. How
// they are brought back down is audible: clip them and you hear a crackle, squash them all
// and the music goes flat.
//
// These assertions describe the properties a listener can actually hear, not the formula —
// so the curve can be retuned freely as long as it still behaves like a limiter.

const test = require('node:test')
const assert = require('node:assert')
const { softLimit, LIMIT_KNEE, LIMIT_CEILING } = require('../../server/audio-engine.cjs')

const FULL = 32767
const KNEE = FULL * LIMIT_KNEE

test('diz altındaki örnekler hiç değişmez', () => {
  // Everything below the knee must be mathematically untouched: normal-level music has to
  // pass through bit-exact, otherwise the limiter is colouring audio it should never touch.
  for (const s of [0, 1, -1, 100, -100, 5000, -5000, KNEE - 1, -(KNEE - 1)]) {
    assert.equal(softLimit(s), s, `${s} dokunulmadan geçmeli`)
  }
})

test('tavan aşılmaz — hiçbir giriş tam ölçeği geçemez', () => {
  // MP3 is lossy and the decoded waveform overshoots the samples themselves, so the curve
  // deliberately tops out below full scale. Cheap DACs clip anything above it.
  const ceiling = FULL * LIMIT_CEILING
  for (const s of [FULL, FULL * 2, FULL * 10, 1e9, -FULL, -FULL * 2, -1e9]) {
    const out = softLimit(s)
    assert.ok(Math.abs(out) <= ceiling + 1, `${s} girişi tavanı aşmamalı (çıkan: ${out}, tavan: ${ceiling})`)
    assert.ok(out >= -32768 && out <= 32767, `${s} girişi 16-bit aralığında kalmalı (çıkan: ${out})`)
  }
})

test('diz noktasında süreklilik — duyulur bir sıçrama yok', () => {
  // A discontinuity at the knee is heard as a click on every transient that crosses it.
  const below = softLimit(KNEE - 0.001)
  const above = softLimit(KNEE + 0.001)
  assert.ok(Math.abs(above - below) < 0.01, `diz noktasında sıçrama olmamalı (${below} -> ${above})`)
  const belowNeg = softLimit(-KNEE + 0.001)
  const aboveNeg = softLimit(-KNEE - 0.001)
  assert.ok(Math.abs(aboveNeg - belowNeg) < 0.01, `negatif tarafta da sıçrama olmamalı (${belowNeg} -> ${aboveNeg})`)
})

test('monoton — daha yüksek giriş asla daha alçak çıkış vermez', () => {
  // Monotonicity is what keeps the waveform's shape. If the curve ever folded back, loud
  // passages would come out distorted rather than merely quieter.
  let previous = -Infinity
  for (let s = -60000; s <= 60000; s += 137) {
    const out = softLimit(s)
    assert.ok(out >= previous - 1e-9, `monotonluk bozuldu: ${s} girişinde ${out} < ${previous}`)
    previous = out
  }
})

test('simetrik — pozitif ve negatif tepeler aynı işlenir', () => {
  // Asymmetric limiting shifts the waveform's DC offset, which sounds like a thickening
  // or buzz rather than clean level control.
  for (const s of [KNEE + 1, 30000, 40000, 80000]) {
    assert.ok(Math.abs(softLimit(s) + softLimit(-s)) < 0.01,
      `${s} ve ${-s} simetrik işlenmeli (${softLimit(s)} vs ${softLimit(-s)})`)
  }
})

test('sıfır giriş sessiz kalır', () => {
  // A limiter that leaks DC into silence produces a constant hum between tracks.
  assert.equal(softLimit(0), 0)
})

test('NaN bir örneği aralık dışına yazamaz', () => {
  // A NaN anywhere in the chain (a bad gainDb, a divide by zero) must not become a
  // wild 16-bit value; writeInt16LE would throw or wrap and the stream would glitch.
  const out = softLimit(NaN)
  assert.ok(Number.isNaN(out) || (out >= -32768 && out <= 32767),
    'NaN için bile 16-bit aralığı korunmalı')
  // The engine writes `softLimit(s) | 0`, and `NaN | 0` is 0 — silence, not a glitch.
  assert.equal(softLimit(NaN) | 0, 0, 'NaN sessizliğe düşmeli')
})

test('normalizasyonla yükseltilmiş gerçekçi bir tepe yumuşatılır, kırpılmaz', () => {
  // The real scenario: a quiet track boosted by +6 dB, then the operator at 150%.
  const boosted = 20000 * (10 ** (6 / 20)) * 1.5      // ≈ 59 800, well past full scale
  const out = softLimit(boosted)
  assert.ok(out < FULL * LIMIT_CEILING + 1, 'tavanın altında kalmalı')
  assert.ok(out > KNEE, 'yine de yüksek kalmalı — limiter sesi boğmamalı')
})
