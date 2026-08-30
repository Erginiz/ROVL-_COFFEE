// The mixer is the last thing every sample passes through before the café hears it, 50 times
// a second. Its arithmetic decides three audible things: how loud the music is, whether an
// announcement can be heard over it, and whether either of them distorts.
//
// The separation of the two gains is the part worth pinning down. The music carries the
// operator's volume, the ducking and the track's normalisation; the announcement carries
// none of those — an announcement must not go quiet because the song underneath happens to
// be a quiet recording, and it must not be ducked by its own ducking setting.

const test = require('node:test')
const assert = require('node:assert')
const { mixChunk, softLimit, CHUNK, MIC_GAIN } = require('../../server/audio-engine.cjs')

// A buffer of one repeated sample value, the size the mixer works in.
const constant = value => {
  const buf = Buffer.alloc(CHUNK)
  for (let i = 0; i < CHUNK; i += 2) buf.writeInt16LE(value, i)
  return buf
}
const firstSample = buf => buf.readInt16LE(0)

test('müzik seviyesi doğrudan uygulanır', () => {
  const music = constant(10000)
  assert.equal(firstSample(mixChunk(music, null, 1)), 10000, 'tam seviyede değişmemeli')
  assert.equal(firstSample(mixChunk(music, null, 0.5)), 5000, 'yarı seviyede yarıya inmeli')
  assert.equal(firstSample(mixChunk(music, null, 0)), 0, 'sıfırda susmalı')
})

test('sessizlik sessiz kalır', () => {
  // A mixer that leaks anything into silence produces a constant hum between tracks.
  assert.equal(firstSample(mixChunk(constant(0), null, 1)), 0)
  assert.equal(firstSample(mixChunk(null, null, 1)), 0)
  assert.equal(firstSample(mixChunk(null, constant(0), 1)), 0)
})

test('anons müziğin seviyesinden etkilenmez', () => {
  // THE property: the same announcement over a quiet track and over a loud one must come out
  // at the same level. Scaling the mic by the music gain would make announcements vanish
  // under quiet songs — exactly when they are needed most.
  const mic = constant(5000)
  const overQuietMusic = firstSample(mixChunk(constant(0), mic, 0.1))
  const overLoudMusic = firstSample(mixChunk(constant(0), mic, 1.0))
  assert.equal(overQuietMusic, overLoudMusic, 'anons seviyesi müzik ayarına bağlı olmamalı')
  assert.equal(overQuietMusic, Math.trunc(5000 * MIC_GAIN), 'anons kendi kazancıyla gelmeli')
})

test('anons müziğin üstüne biner (ikisi toplanır)', () => {
  const mixed = firstSample(mixChunk(constant(4000), constant(3000), 0.5))
  const expected = softLimit(4000 * 0.5 + 3000 * MIC_GAIN) | 0
  assert.equal(mixed, expected, 'müzik ve anons toplanmalı')
  assert.ok(mixed > 4000 * 0.5, 'anons duyulacak şekilde eklenmeli')
})

test('kısma (ducking) müziği düşürür, anonsu değil', () => {
  // How the setting actually works: the ducking is folded into the music gain by the caller.
  const music = constant(20000)
  const mic = constant(6000)
  const ducked = firstSample(mixChunk(music, mic, 1 * 0.2))   // %80 kısma
  const notDucked = firstSample(mixChunk(music, mic, 1))
  assert.ok(ducked < notDucked, 'kısma müziği düşürmeli')
  // The announcement's own contribution is unchanged; only the music moved.
  assert.equal(ducked - Math.trunc(6000 * MIC_GAIN), Math.trunc(20000 * 0.2), 'yalnızca müzik kısılmalı')
})

test('yükseltilmiş seviyeler kırpılmaz, yumuşatılır', () => {
  // The operator can push past 100% and normalisation boosts quiet files; both push samples
  // over full scale. Hard clipping there is heard as a crackle.
  const loud = firstSample(mixChunk(constant(30000), null, 2))
  assert.ok(loud <= 32767, '16-bit aralığında kalmalı')
  assert.ok(loud < 32767, 'tam ölçekte kırpılmamalı (tavan altında kalmalı)')
  assert.ok(loud > 20000, 'yine de yüksek olmalı — limiter sesi boğmamalı')
})

test('negatif tepeler de simetrik işlenir', () => {
  const positive = firstSample(mixChunk(constant(30000), null, 2))
  const negative = firstSample(mixChunk(constant(-30000), null, 2))
  assert.ok(Math.abs(positive + negative) <= 1, 'pozitif ve negatif aynı işlenmeli')
})

test('çıktı her zaman tam bir 20 ms parçasıdır', () => {
  // The encoder is fed fixed-size chunks; a short buffer would shift every following frame.
  for (const args of [[constant(100), null, 1], [null, constant(100), 1], [constant(1), constant(1), 0.3]]) {
    assert.equal(mixChunk(...args).length, CHUNK, 'parça boyutu sabit olmalı')
  }
})

test('anons parçası müzikten kısaysa taşma olmaz', () => {
  // The mic queue can hand over less than a full chunk at the edges of an announcement.
  const shortMic = Buffer.alloc(CHUNK / 2)
  shortMic.writeInt16LE(8000, 0)
  const out = mixChunk(constant(1000), shortMic, 1)
  assert.equal(out.length, CHUNK)
  assert.equal(out.readInt16LE(0), Math.trunc(1000 + 8000 * MIC_GAIN), 'kapsanan kısımda karışmalı')
  // Past the end of the mic buffer only the music remains — no reading past the edge.
  assert.equal(out.readInt16LE(CHUNK - 2), 1000, 'anons bitince müzik tek başına devam etmeli')
})

test('geçersiz kazanç sessizliğe düşer, gürültüye değil', () => {
  // A NaN gain (a corrupt gainDb, a bad setting) must not become a wild value: `NaN | 0` is
  // 0, so the worst case is silence rather than a burst of noise at full scale.
  const out = mixChunk(constant(10000), null, NaN)
  assert.equal(out.readInt16LE(0), 0, 'geçersiz kazanç sessizlik vermeli')
})
