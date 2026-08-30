// The admin code is six digits — a million guesses — and it is the only thing standing
// between a phone on the café Wi-Fi and the station's controls. The per-IP lockout in
// index.cjs caps one address at five tries a minute, which is a fine brake on a person
// fat-fingering the code, and no brake at all on an attacker.
//
// Proved on this machine before writing any of this: lock 127.0.1.30 out, then log in from
// 192.168.1.14 and the very first attempt is answered normally. Changing source address is
// free — an IPv6 privacy extension does it on its own schedule — so the per-address counter
// bounds politeness, not the guess rate. With the source published, that matters.
//
// This is the brake that does bound the rate: one counter over every failed check, whatever
// address it came from. It lives in its own module so the thresholds and the cooldown can be
// tested against an injected clock instead of whatever time the test happens to run at.

// Far above real use — a mistyped code is one or two failures, a shift's worth of staff
// phones a handful — and low enough to matter: 30 guesses per 7 minutes walks a million
// codes in about 160 days.
const WINDOW_MS = 5 * 60000
const MAX_FAILURES = 30
const COOLDOWN_MS = 2 * 60000

function createLoginBrake({ windowMs = WINDOW_MS, maxFailures = MAX_FAILURES, cooldownMs = COOLDOWN_MS } = {}) {
  let windowStartedAt = 0
  let failures = 0
  let lockedUntil = 0

  return {
    // True while the brake is engaged. The caller must still let the café's own machine
    // through: it does not authenticate at all, and rotating the code from there is how the
    // operator ends an attack. Locking out new phone logins during one is the point, not a
    // side effect — a phone that already holds a token keeps working.
    locked(now = Date.now()) { return now < lockedUntil },

    // Records one failed code check. Returns true if this failure engaged the brake, so the
    // caller can tell the operator once rather than on every attempt.
    noteFailure(now = Date.now()) {
      if (now - windowStartedAt > windowMs) { windowStartedAt = now; failures = 0 }
      failures += 1
      if (failures >= maxFailures) {
        lockedUntil = now + cooldownMs
        windowStartedAt = now
        failures = 0
        return true
      }
      return false
    },

    // A correct code means whoever is there belongs here; the count should not follow them
    // into the next window as if it were part of an attack.
    noteSuccess() { windowStartedAt = 0; failures = 0; lockedUntil = 0 },

    // For tests and for reporting how long a caller must wait.
    remainingMs(now = Date.now()) { return Math.max(0, lockedUntil - now) }
  }
}

module.exports = { createLoginBrake, WINDOW_MS, MAX_FAILURES, COOLDOWN_MS }
