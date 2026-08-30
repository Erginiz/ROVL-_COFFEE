// The server stopped sending the music and ad lists on every frame — they are most of the
// payload and go out hundreds of times an hour over the same Wi-Fi the audio is streaming on.
// A frame without them means "unchanged", and the page keeps what it has.
//
// That is a quiet contract with a loud failure mode: read it as "now empty" and the panel's
// library vanishes, the phone's track list empties, and nothing errors. Verified in a real
// browser when it was written — this is what keeps it true when someone simplifies the merge
// later, which is exactly the kind of change that looks harmless.
//
// Queried through the track LIST, never by title text. The first version of this file matched
// titles anywhere on the page and so kept matching the now-playing line; removing the merge
// entirely did not fail a single assertion.

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, waitFor } from '@testing-library/react'
import { Listener } from '../../src/main.jsx'

// An EventSource the test can push frames through, standing in for the server's stream.
let live = null
class TestEventSource {
  constructor() { live = this; this.close = () => { live = null } }
  send(payload) { this.onmessage?.({ data: JSON.stringify(payload) }) }
}

const fullFrame = (overrides = {}) => ({
  station: { name: 'Rovli Radyo' },
  playback: { status: 'playing', currentId: 'm1', currentType: 'music', musicVolume: 76, adVolume: 90, currentOffsetSeconds: 5, currentStartedAt: new Date().toISOString(), shuffle: true },
  adSettings: { songsEnabled: true, songsEvery: 5, timedEnabled: false, timedMinutes: 60 },
  microphone: { enabled: false, ducking: 35 },
  music: [{ id: 'm1', title: 'Bir Şarkı', durationSeconds: 200 }, { id: 'm2', title: 'İkinci Şarkı', durationSeconds: 180 }],
  ads: [{ id: 'a1', title: 'Bir Reklam', durationSeconds: 20 }],
  history: [], queues: { music: [], adCursor: 0 },
  ezan: { enabled: false, active: false, times: {}, il: 'İstanbul' },
  current: { id: 'm1', title: 'Bir Şarkı', artist: 'Bir Sanatçı', durationSeconds: 200 },
  listeners: 1,
  timing: { targetLatencySeconds: 2 },
  network: { ip: '192.168.1.14', port: 8090, ips: [], reachedVia: [], firewall: null, webUrl: 'http://192.168.1.14:8090/listen', streamUrl: 'http://192.168.1.14:8090/live.mp3' },
  capabilities: { flowing: true, message: 'aktif' },
  ...overrides
})

// What the server actually sends once a client is up to date: everything except the lists.
const leanFrame = (overrides = {}) => {
  const { music, ads, ...lean } = fullFrame(overrides)
  return lean
}

// The library is only RENDERED in the phone's admin view ("Şarkı Seç"), so that is where it
// has to be read from.
const trackList = () => [...document.querySelectorAll('.mobile-tracklist .track-row')]
  .map(row => row.textContent)

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('cr_admin_token', 'test-token')
  globalThis.EventSource = TestEventSource
  globalThis.fetch = vi.fn(async url => {
    const body = String(url).includes('/api/qr') ? { dataUrl: 'data:image/png;base64,AAAA' } : fullFrame()
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
  })
})
afterEach(() => { cleanup(); live = null })

const rendered = async () => {
  render(<Listener />)
  await waitFor(() => expect(trackList().length).toBe(2))
}

describe('Kırpılmış yayın karelerinin birleştirilmesi', () => {
  test('kütüphane taşımayan kare gelince eldeki liste korunur', async () => {
    await rendered()

    // A frame with no music/ads key at all, exactly as the server sends it.
    await act(async () => { live.send(leanFrame({ listeners: 7 })) })

    // The frame WAS applied...
    await waitFor(() => expect(screen.getByText(/7 kişi/)).toBeDefined())
    // ...and the library it did not carry is still on screen.
    expect(trackList().length).toBe(2)
    expect(trackList().join(' ')).toContain('İkinci Şarkı')
  })

  test('arka arkaya gelen kırpılmış kareler listeyi aşındırmaz', async () => {
    // The café's normal state: one library frame on connect, then hundreds of lean ones.
    await rendered()
    for (let i = 0; i < 8; i++) {
      await act(async () => { live.send(leanFrame({ listeners: i })) })
    }
    expect(trackList().length).toBe(2)
  })

  test('kütüphane taşıyan kare listeyi günceller', async () => {
    // The saving must never cost correctness: an uploaded or deleted track has to arrive.
    await rendered()

    await act(async () => {
      live.send(fullFrame({ music: [{ id: 'm9', title: 'Yeni Yüklenen', durationSeconds: 150 }] }))
    })
    await waitFor(() => expect(trackList().length).toBe(1))
    expect(trackList().join(' ')).toContain('Yeni Yüklenen')
  })

  test('boş kütüphane gönderildiğinde gerçekten boşalır', async () => {
    // The one case that must NOT be read as "unchanged": an empty array is a value the server
    // chose to send, not an omission. Confusing the two would leave a deleted library on
    // screen for ever.
    await rendered()
    await act(async () => { live.send(fullFrame({ music: [], ads: [] })) })
    await waitFor(() => expect(trackList().length).toBe(0))
  })

  test('ilk kare kütüphanesiz gelse bile sayfa çökmez', async () => {
    // A reconnect can deliver a lean frame before the one-shot /api/state fetch resolves.
    // There is nothing to keep at that point, and the page still has to render.
    globalThis.fetch = vi.fn(() => new Promise(() => {}))   // never resolves
    render(<Listener />)
    await act(async () => { await Promise.resolve() })
    await act(async () => { live?.send(leanFrame()) })
    expect(document.body.textContent.length).toBeGreaterThan(0)
  })
})
