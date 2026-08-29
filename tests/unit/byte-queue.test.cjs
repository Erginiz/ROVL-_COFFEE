// ByteQueue sits between the decoder and the mixer. ffmpeg hands over PCM in arbitrary
// chunk sizes; the mixer needs exactly 3840 bytes (20 ms) at a time. Every mis-sliced byte
// shifts the stereo frame boundary, which is heard as a click or as swapped channels — so
// the "exactly N or nothing" contract is worth pinning down precisely.

const test = require('node:test')
const assert = require('node:assert')
const { ByteQueue } = require('../../server/audio-engine.cjs')

const seq = (from, length) => Buffer.from(Array.from({ length }, (_, i) => (from + i) % 256))

test('yeterli veri yokken null döner ve kuyruğu tüketmez', () => {
  // Returning a short buffer here would desync the stereo frame for the rest of the track.
  const q = new ByteQueue()
  q.push(Buffer.alloc(10))
  assert.equal(q.pull(20), null, 'eksik veriyle null dönmeli')
  assert.equal(q.len, 10, 'başarısız pull kuyruktan bayt yememeli')
  q.push(Buffer.alloc(10))
  assert.notEqual(q.pull(20), null, 'veri tamamlanınca dönmeli')
})

test('birden çok tampona yayılmış veriyi doğru sırayla birleştirir', () => {
  // The decoder's chunk boundaries are arbitrary and never line up with 20 ms frames.
  const q = new ByteQueue()
  q.push(seq(0, 5)); q.push(seq(5, 5)); q.push(seq(10, 5))
  const out = q.pull(12)
  assert.deepEqual([...out], [...seq(0, 12)], 'baytlar sırasını korumalı')
  assert.equal(q.len, 3, 'kalan baytlar kuyrukta durmalı')
  assert.deepEqual([...q.pull(3)], [...seq(12, 3)], 'kalan bayt sırası da doğru olmalı')
})

test('bir tamponun ortasından bölme kalanı bozmaz', () => {
  // The partial-buffer path (subarray) is where an off-by-one would silently corrupt audio.
  const q = new ByteQueue()
  q.push(seq(0, 100))
  assert.deepEqual([...q.pull(30)], [...seq(0, 30)])
  assert.deepEqual([...q.pull(30)], [...seq(30, 30)])
  assert.equal(q.len, 40)
  assert.deepEqual([...q.pull(40)], [...seq(60, 40)])
  assert.equal(q.len, 0)
  assert.equal(q.pull(1), null, 'boşalınca null dönmeli')
})

test('boş ve sıfır uzunluklu girişler kuyruğu bozmaz', () => {
  const q = new ByteQueue()
  q.push(null); q.push(undefined); q.push(Buffer.alloc(0))
  assert.equal(q.len, 0, 'boş girişler uzunluğu değiştirmemeli')
  assert.equal(q.pull(1), null)
  q.push(seq(0, 4))
  assert.deepEqual([...q.pull(4)], [...seq(0, 4)], 'boş girişlerden sonra normal çalışmalı')
})

test('clear kuyruğu tamamen boşaltır', () => {
  // Called on every track change: a leftover tail from the previous song would be heard
  // as a fragment of the old track at the start of the new one.
  const q = new ByteQueue()
  q.push(seq(0, 50))
  q.clear()
  assert.equal(q.len, 0)
  assert.equal(q.pull(1), null)
  q.push(seq(99, 10))
  assert.deepEqual([...q.pull(10)], [...seq(99, 10)], 'clear sonrası yeniden kullanılabilmeli')
})

test('gerçekçi akış: rastgele parça boyutlarında bayt kaybı olmaz', () => {
  // The property that actually matters end to end: whatever chunking the decoder uses,
  // the bytes coming out are the bytes that went in, in order, with none lost or repeated.
  const q = new ByteQueue()
  const CHUNK = 3840
  const written = []
  const read = []
  let counter = 0
  for (let round = 0; round < 200; round++) {
    const size = 1 + Math.floor(Math.random() * 5000)
    const buf = seq(counter, size)
    counter = (counter + size) % 256
    written.push(buf)
    q.push(buf)
    let out
    while ((out = q.pull(CHUNK)) !== null) read.push(out)
  }
  const all = Buffer.concat(written)
  const got = Buffer.concat(read)
  assert.ok(got.length <= all.length, 'okunan veri yazılandan fazla olamaz')
  assert.equal(got.length % CHUNK, 0, 'okunan veri tam kare katları olmalı')
  assert.deepEqual([...got], [...all.subarray(0, got.length)], 'baytlar birebir ve sırasıyla çıkmalı')
  assert.equal(q.len, all.length - got.length, 'kalan uzunluk tutarlı olmalı')
})
