// The per-IP lockout does not bound the guess rate — changing source address resets it, and
// that was measured against the running station, not assumed. This brake is what does bound
// it, so its edges are worth stating precisely: when it engages, when it lets go, and what
// does not trip it.
//
// Tested against an injected clock. Waiting out a real two-minute cooldown in the suite would
// buy nothing except a slower suite.

const test = require('node:test')
const assert = require('node:assert')
const { createLoginBrake } = require('../../server/login-brake.cjs')

const T0 = 1_700_000_000_000        // sabit bir başlangıç: gerçek saat testin sonucunu etkilemesin

test('normal kullanım freni tetiklemez', () => {
  // A mistyped code is one or two failures; a shift's worth of staff phones, a handful. If
  // ordinary use engaged this, the café would lock itself out and the brake would be removed.
  const brake = createLoginBrake()
  for (let i = 0; i < 8; i++) brake.noteFailure(T0 + i * 1000)
  assert.equal(brake.locked(T0 + 9000), false)
})

test('eşiğe ulaşınca fren devreye girer', () => {
  const brake = createLoginBrake({ maxFailures: 30 })
  let engaged = false
  for (let i = 0; i < 30; i++) engaged = brake.noteFailure(T0 + i * 100)
  assert.equal(engaged, true, 'eşiği aşan deneme freni kurduğunu bildirmeli')
  assert.equal(brake.locked(T0 + 5000), true)
})

test('kaynak adresi ne olursa olsun sayılır', () => {
  // The whole reason this exists: the brake has no notion of where a failure came from, so
  // rotating addresses buys an attacker nothing.
  const brake = createLoginBrake({ maxFailures: 10 })
  for (let i = 0; i < 10; i++) brake.noteFailure(T0 + i * 50)
  assert.equal(brake.locked(T0 + 1000), true)
})

test('bekleme süresi dolunca serbest bırakır', () => {
  // A brake that never lets go would hand an attacker a permanent denial of service against
  // the café's own staff phones.
  const brake = createLoginBrake({ maxFailures: 5, cooldownMs: 120000 })
  for (let i = 0; i < 5; i++) brake.noteFailure(T0)
  assert.equal(brake.locked(T0 + 119000), true, 'süre dolmadan açılmamalı')
  assert.equal(brake.locked(T0 + 121000), false, 'süre dolunca açılmalı')
})

test('seyrek hatalar birikip fren yapmaz', () => {
  // Five failures a day is not an attack. Without a rolling window they would accumulate
  // for ever and the station would eventually lock itself out of nowhere.
  const brake = createLoginBrake({ maxFailures: 10, windowMs: 300000 })
  for (let i = 0; i < 20; i++) brake.noteFailure(T0 + i * 400000)   // her biri pencereden uzak
  assert.equal(brake.locked(T0 + 20 * 400000), false)
})

test('doğru kod sayacı temizler', () => {
  // Whoever just proved they know the code belongs here; their neighbours' typos should not
  // follow them into the next window as if they were part of an attack.
  const brake = createLoginBrake({ maxFailures: 5 })
  for (let i = 0; i < 4; i++) brake.noteFailure(T0 + i * 100)
  brake.noteSuccess()
  for (let i = 0; i < 4; i++) brake.noteFailure(T0 + 1000 + i * 100)
  assert.equal(brake.locked(T0 + 2000), false, 'başarıdan sonra sayaç sıfırdan başlamalı')
})

test('fren kurulduğunu yalnızca bir kez bildirir', () => {
  // The caller writes this to the operator's log. Reporting on every attempt during an
  // attack would bury the hundred-entry history under the attack itself.
  const brake = createLoginBrake({ maxFailures: 3 })
  const reports = []
  for (let i = 0; i < 9; i++) reports.push(brake.noteFailure(T0 + i * 100))
  assert.equal(reports.filter(Boolean).length, 3, 'her eşik geçişinde bir kez — sürekli değil')
})

test('kalan süre bildirilebilir', () => {
  const brake = createLoginBrake({ maxFailures: 2, cooldownMs: 60000 })
  brake.noteFailure(T0); brake.noteFailure(T0)
  assert.equal(brake.remainingMs(T0 + 20000), 40000)
  assert.equal(brake.remainingMs(T0 + 90000), 0)
})
