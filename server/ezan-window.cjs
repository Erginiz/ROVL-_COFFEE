// Deciding whether "now" falls inside a prayer window sounds trivial and is not: the window
// is expressed in wall-clock minutes, it can run past midnight, and getting it wrong is
// audible in the café either way — music playing through the call to prayer, or silence long
// after it ended.
//
// Kept as a pure function so those cases can be tested with an injected clock. They cannot be
// tested against the running server: a window only wraps midnight when "now" is within an
// hour of it, so the test would pass or fail depending on what time it happened to run.

const MINUTES_PER_DAY = 24 * 60

// times: { 'Öğle': '13:19', ... }  durationMinutes: how long music stays silenced
// now: a Date. Returns { prayer, minutesLeft } when inside a window, otherwise null.
function findActiveWindow(times, durationMinutes, now = new Date()) {
  const duration = Math.max(1, Math.min(60, Number(durationMinutes) || 8))
  const nowMinutes = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60

  for (const [prayer, hhmm] of Object.entries(times || {})) {
    const parsed = String(hhmm).match(/(\d{1,2}):(\d{2})/)
    if (!parsed) continue
    const hours = Number(parsed[1])
    const minutes = Number(parsed[2])
    if (hours > 23 || minutes > 59) continue          // a malformed schedule is not a window
    const start = hours * 60 + minutes

    // Two candidate positions for "now" against this window: today's, and today's seen from
    // the previous day. The second is what covers a window that started before midnight and
    // has not finished yet — Yatsı at 23:10 with an hour's duration ends at 00:10.
    const position = [nowMinutes, nowMinutes + MINUTES_PER_DAY]
      .find(candidate => candidate >= start && candidate < start + duration)

    if (position != null) return { prayer, minutesLeft: start + duration - position }
  }
  return null
}

module.exports = { findActiveWindow }
