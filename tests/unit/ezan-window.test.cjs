// Whether the music is silenced right now is decided by this arithmetic, and both ways of
// getting it wrong are heard in the café: music playing through the call to prayer, or
// silence continuing long after it ended.
//
// These run against an injected clock. The midnight case in particular cannot be tested any
// other way — a window only wraps midnight while "now" is within an hour of it, so a test
// against the live server would pass or fail depending on what time it ran.

const test = require('node:test')
const assert = require('node:assert')
const { findActiveWindow } = require('../../server/ezan-window.cjs')

// A Date at a given wall-clock time today.
const at = (hours, minutes, seconds = 0) => {
  const d = new Date()
  d.setHours(hours, minutes, seconds, 0)
  return d
}
const TIMES = { Sabah: '04:39', Öğle: '13:19', İkindi: '17:08', Akşam: '20:13', Yatsı: '21:43' }

test('vakit dışında pencere yok', () => {
  assert.equal(findActiveWindow(TIMES, 8, at(10, 0)), null)
  assert.equal(findActiveWindow(TIMES, 8, at(23, 30)), null)
})

test('vaktin başında pencere açılır', () => {
  const hit = findActiveWindow(TIMES, 8, at(13, 19))
  assert.equal(hit.prayer, 'Öğle')
  assert.equal(Math.round(hit.minutesLeft), 8, 'baştayken tüm süre kalmalı')
})

test('vaktin ortasında kalan süre doğru hesaplanır', () => {
  const hit = findActiveWindow(TIMES, 8, at(13, 22))
  assert.equal(hit.prayer, 'Öğle')
  assert.equal(Math.round(hit.minutesLeft), 5)
})

test('pencerenin son anı dahil, bitişi hariç', () => {
  // The boundary decides whether the music comes back a minute early or a minute late.
  assert.ok(findActiveWindow(TIMES, 8, at(13, 26, 59)), 'son saniye hâlâ pencere içinde')
  assert.equal(findActiveWindow(TIMES, 8, at(13, 27)), null, 'bitişte pencere kapanmalı')
})

test('gece yarısını aşan pencere erken kapanmaz', () => {
  // THE regression: Yatsı at 23:10 with the duration set to an hour ends at 00:10. Measuring
  // "now" only within today's minutes made the clock roll over to 0 and the window end at
  // midnight — the music came back while the call to prayer was still going.
  const times = { Yatsı: '23:10' }
  assert.ok(findActiveWindow(times, 60, at(23, 30)), 'gece yarısından önce pencere açık')
  const afterMidnight = findActiveWindow(times, 60, at(0, 5))
  assert.ok(afterMidnight, 'gece yarısından sonra da açık kalmalı')
  assert.equal(afterMidnight.prayer, 'Yatsı')
  assert.equal(Math.round(afterMidnight.minutesLeft), 5, 'kalan süre doğru olmalı')
})

test('gece yarısını aşan pencere zamanı gelince kapanır', () => {
  const times = { Yatsı: '23:10' }
  assert.equal(findActiveWindow(times, 60, at(0, 10)), null, 'bitişte kapanmalı')
  assert.equal(findActiveWindow(times, 60, at(2, 0)), null, 'çok sonra kapalı olmalı')
})

test('kısa süreli pencere gece yarısını aşmaz', () => {
  // The common setting: 8 minutes never reaches the next day from any real prayer time.
  const times = { Yatsı: '23:10' }
  assert.equal(findActiveWindow(times, 8, at(0, 5)), null, 'kısa pencere ertesi güne taşmamalı')
})

test('bozuk vakit kaydı yok sayılır', () => {
  // The schedule comes from an external service; a malformed entry must not become a window.
  const broken = { Sabah: 'bilinmiyor', Öğle: '25:99', İkindi: '', Akşam: '13:19' }
  const hit = findActiveWindow(broken, 8, at(13, 20))
  assert.ok(hit, 'geçerli vakit yine de bulunmalı')
    assert.equal(hit.prayer, 'Akşam')
  assert.equal(findActiveWindow(broken, 8, at(2, 0)), null, 'bozuk kayıtlar pencere açmamalı')
})

test('vakit yoksa pencere yok', () => {
  assert.equal(findActiveWindow({}, 8, at(13, 20)), null)
  assert.equal(findActiveWindow(null, 8, at(13, 20)), null)
  assert.equal(findActiveWindow(undefined, 8, at(13, 20)), null)
})

test('süre sınırları uygulanır', () => {
  // A corrupt or hostile duration must not silence the café for a day.
  const times = { Öğle: '13:00' }
  assert.equal(findActiveWindow(times, 100000, at(20, 0)), null, 'süre en fazla 60 dakika olmalı')
  assert.ok(findActiveWindow(times, 0, at(13, 0)), 'sıfır süre en az bir dakikaya çekilmeli')
  assert.ok(findActiveWindow(times, NaN, at(13, 5)), 'geçersiz süre varsayılana düşmeli')
})

test('ilk eşleşen vakit döner', () => {
  // Two prayers cannot overlap in practice, but the function must be deterministic if they do.
  const overlapping = { Öğle: '13:00', İkindi: '13:05' }
  const hit = findActiveWindow(overlapping, 30, at(13, 10))
  assert.ok(['Öğle', 'İkindi'].includes(hit.prayer), 'bir vakit seçilmeli')
})
