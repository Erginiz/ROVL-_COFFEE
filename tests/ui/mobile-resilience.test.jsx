// The listener page runs on a phone in someone's pocket. The failures that matter are not
// crashes — they are the page looking fine while producing no sound: an audio element the OS
// paused when the screen locked, a session that expired overnight, a stream that ended and
// was never re-requested.
//
// Every one of these has actually happened in this project, and none of them raise an error.

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react'
import { Listener } from '../../src/main.jsx'

const station = (overrides = {}) => ({
  station: { name: 'Rovli Radyo' },
  playback: { status: 'playing', currentId: 'm1', currentType: 'music', musicVolume: 76, adVolume: 90, currentOffsetSeconds: 5, currentStartedAt: new Date().toISOString(), shuffle: true },
  adSettings: { songsEnabled: true, songsEvery: 5, timedEnabled: false, timedMinutes: 60 },
  microphone: { enabled: false, ducking: 35 },
  music: [{ id: 'm1', title: 'Bir Şarkı', durationSeconds: 200 }],
  ads: [], history: [], queues: { music: [], adCursor: 0 },
  ezan: { enabled: false, active: false, times: {}, il: 'İstanbul' },
  current: { id: 'm1', title: 'Bir Şarkı', artist: 'Bilinmeyen sanatçı', durationSeconds: 200 },
  listeners: 1,
  timing: { targetLatencySeconds: 2 },
  network: { ip: '192.168.1.14', ips: [], reachedVia: [], webUrl: 'http://192.168.1.14:8090/listen', adminUrl: 'https://192.168.1.14:8443/listen', streamUrl: 'http://192.168.1.14:8090/live.mp3' },
  capabilities: { message: 'aktif' },
  ...overrides
})

// Records what the page asks the audio element to do. jsdom ships no media stack at all:
// play() does nothing, no events fire, and `paused` is a read-only getter. Standing all three
// up is what lets the page's real logic run — and what it CALLS, at which moment, is exactly
// what these tests are about.
let playCalls = 0
let pauseCalls = 0
function stubMediaElement() {
  playCalls = 0
  pauseCalls = 0
  const proto = window.HTMLMediaElement.prototype
  Object.defineProperty(proto, 'paused', {
    configurable: true,
    get() { return this._paused !== false },
    set(value) { this._paused = value }
  })
  Object.defineProperty(proto, 'play', {
    configurable: true,
    value: vi.fn(function () {
      playCalls++
      this._paused = false
      // The real element announces this, and the page's UI state follows the events rather
      // than the call — so the stub has to announce it too.
      this.dispatchEvent(new Event('play'))
      this.dispatchEvent(new Event('playing'))
      return Promise.resolve()
    })
  })
  Object.defineProperty(proto, 'pause', {
    configurable: true,
    value: vi.fn(function () {
      pauseCalls++
      this._paused = true
      this.dispatchEvent(new Event('pause'))
    })
  })
  Object.defineProperty(proto, 'load', { configurable: true, value: vi.fn() })
}
// Puts the element in the state a locked screen leaves behind: still wanted, but paused by
// the OS without the page being told.
const simulateOsPause = () => { document.querySelector('audio')._paused = true }
const returnToForeground = async (event = 'visibilitychange') => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  await act(async () => {
    if (event === 'pageshow') window.dispatchEvent(new Event('pageshow'))
    else document.dispatchEvent(new Event('visibilitychange'))
  })
}

function mockNetwork(payload = station()) {
  globalThis.fetch = vi.fn(async url => {
    const body = String(url).includes('/api/qr') ? { dataUrl: 'data:image/png;base64,AAAA' } : payload
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
  })
  globalThis.EventSource = class { constructor() { this.close = () => {} } }
}

beforeEach(() => { localStorage.clear(); mockNetwork(); stubMediaElement() })
afterEach(() => cleanup())

describe('Telefonda dinleme dayanıklılığı', () => {
  test('dinlemeye başla düğmesi yayını başlatır', async () => {
    render(<Listener />)
    const button = await screen.findByText(/Canlı Dinlemeye Başla/)
    fireEvent.click(button)
    expect(playCalls).toBeGreaterThan(0)
  })

  test('ekran kilidinden dönünce çalma kendiliğinden sürer', async () => {
    // THE mobile bug: the OS pauses the element when the screen locks and does not resume it.
    // The listener comes back to a page that looks like it is playing and hears nothing.
    render(<Listener />)
    fireEvent.click(await screen.findByText(/Canlı Dinlemeye Başla/))
    const before = playCalls

    // The phone went away and came back, with the element left paused by the OS.
    simulateOsPause()
    await returnToForeground()

    expect(playCalls).toBeGreaterThan(before)
  })

  test('iOS bfcache dönüşü (pageshow) de çalmayı sürdürür', async () => {
    // Safari restores the page from its back/forward cache without a visibilitychange.
    render(<Listener />)
    fireEvent.click(await screen.findByText(/Canlı Dinlemeye Başla/))
    const before = playCalls

    simulateOsPause()
    await returnToForeground('pageshow')

    expect(playCalls).toBeGreaterThan(before)
  })

  test('kullanıcı duraklattıysa arka plandan dönüş çalmayı başlatmaz', async () => {
    // Intent matters: resuming audio the listener deliberately stopped would be worse than
    // the bug it is meant to fix — a phone that starts playing in someone's pocket.
    render(<Listener />)
    fireEvent.click(await screen.findByText(/Canlı Dinlemeye Başla/))
    fireEvent.click(await screen.findByText(/Duraklat/))   // the user stops it
    const before = playCalls

    simulateOsPause()
    await returnToForeground()

    expect(playCalls).toBe(before)
  })

  test('sekme arka plandayken hiçbir şey yapılmaz', async () => {
    render(<Listener />)
    fireEvent.click(await screen.findByText(/Canlı Dinlemeye Başla/))
    const before = playCalls

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })

    expect(playCalls).toBe(before)
  })

  test('duraklat düğmesi çalmayı gerçekten durdurur', async () => {
    render(<Listener />)
    fireEvent.click(await screen.findByText(/Canlı Dinlemeye Başla/))
    fireEvent.click(await screen.findByText(/Duraklat/))
    expect(pauseCalls).toBeGreaterThan(0)
  })

  test('yayın akışı göreli adresle isteniyor (hangi adresten girilirse girilsin)', async () => {
    // An absolute URL would send a phone that reached the station by one address to a
    // different one — the exact failure a café with two networks runs into.
    render(<Listener />)
    await screen.findByText(/Canlı Dinlemeye Başla/)
    const audio = document.querySelector('audio')
    const src = audio.getAttribute('src')
    expect(src).toBe('/live.mp3')
  })

  test('kilit ekranı bilgisi (MediaSession) ayarlanır', async () => {
    // Declaring the stream as background media is what keeps phones playing with the screen
    // off, and it puts the station's name on the lock screen instead of a blank control.
    const setActionHandler = vi.fn()
    globalThis.navigator.mediaSession = { setActionHandler, metadata: null, playbackState: 'none' }
    globalThis.MediaMetadata = class { constructor(init) { Object.assign(this, init) } }

    render(<Listener />)
    await screen.findByText(/Canlı Dinlemeye Başla/)

    await waitFor(() => expect(setActionHandler).toHaveBeenCalled())
    const handled = setActionHandler.mock.calls.map(c => c[0])
    expect(handled).toContain('play')
    expect(handled).toContain('pause')
    expect(navigator.mediaSession.metadata?.title).toBeTruthy()
  })
})
