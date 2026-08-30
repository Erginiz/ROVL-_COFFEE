// Every listening phone runs this decision every two seconds, and both of its outcomes are
// things the café hears: a 3% speed-up makes the music subtly sharp for as long as it lasts,
// and a seek is an audible jump mid-song. It had no test at all.
//
// The thresholds are the whole design, so they are what is pinned here — not the arithmetic.

import { describe, test, expect } from 'vitest'
import { liveEdgeAction } from '../../src/main.jsx'

describe('Canlı yayın kenarına hizalama', () => {
  test('kenardaysa hiçbir şey yapılmaz', () => {
    const action = liveEdgeAction(0.1, 1)
    expect(action.seek).toBe(false)
    expect(action.rate).toBe(1)
  })

  test('biraz geri kalınca hızlanır', () => {
    // Slightly fast is how a phone catches up without anyone noticing a jump.
    const action = liveEdgeAction(2, 1)
    expect(action.seek).toBe(false)
    expect(action.rate).toBeGreaterThan(1)
    expect(action.rate).toBeLessThan(1.1)
  })

  test('çok geri kalınca hızlanmaz, atlar', () => {
    // Ten seconds behind at 1.03x would take more than five minutes to close, audibly sharp
    // the whole way. A jump costs one moment instead.
    const action = liveEdgeAction(10, 1.03)
    expect(action.seek).toBe(true)
    expect(action.rate).toBe(1)
  })

  test('yetiştikten sonra normal hıza döner', () => {
    // Without this the phone stays fast for the rest of the session — the failure nobody
    // would report as a bug, just "the music sounds a bit off".
    const action = liveEdgeAction(0.2, 1.03)
    expect(action.rate).toBe(1)
  })

  test('ara bantta hız değiştirilmez (iki saniyede bir gidip gelmesin)', () => {
    // A phone hovering at the threshold would otherwise flip between speeds every tick,
    // which is far more audible than the drift it is correcting.
    expect(liveEdgeAction(0.7, 1.03).rate).toBe(1.03)
    expect(liveEdgeAction(0.7, 1).rate).toBe(1)
  })

  test('önde olmak (negatif gecikme) bir şey tetiklemez', () => {
    // Browsers report this transiently while buffering; acting on it would seek backwards.
    expect(liveEdgeAction(-1, 1)).toBeNull()
  })

  test('ölçülemeyen değerler yok sayılır', () => {
    // buffered.end() before anything is buffered, and the moment a stream is re-requested.
    expect(liveEdgeAction(NaN, 1)).toBeNull()
    expect(liveEdgeAction(Infinity, 1)).toBeNull()
    expect(liveEdgeAction(undefined, 1)).toBeNull()
  })

  test('eşikler tutarlı: atlama eşiği hızlanma eşiğinin üstünde', () => {
    // If these ever crossed, a phone would seek before it ever tried to catch up gently —
    // trading every small drift for an audible jump.
    let firstSeek = null
    let firstSpeedUp = null
    for (let behind = 0; behind < 12; behind += 0.1) {
      const action = liveEdgeAction(behind, 1)
      if (firstSpeedUp === null && action.rate > 1) firstSpeedUp = behind
      if (firstSeek === null && action.seek) firstSeek = behind
    }
    expect(firstSpeedUp).not.toBeNull()
    expect(firstSeek).not.toBeNull()
    expect(firstSeek).toBeGreaterThan(firstSpeedUp)
  })
})
