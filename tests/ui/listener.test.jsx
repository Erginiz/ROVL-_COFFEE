// The listener page is what every customer sees. Its failures in this project have all been
// of the same kind: it renders, it looks right, and it does not work — a slider sitting at
// zero, a note that never appears, an announcement that goes nowhere. None of those raise an
// error, so only a rendered test catches them.

import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { Listener, ConnectCard, UpdateCard } from '../../src/main.jsx'

// A station payload shaped like the real /api/state response.
const station = (overrides = {}) => ({
  station: { name: 'Rovli Radyo' },
  playback: { status: 'playing', currentId: 'm1', currentType: 'music', musicVolume: 76, adVolume: 90, currentOffsetSeconds: 10, currentStartedAt: new Date().toISOString(), shuffle: true },
  adSettings: { songsEnabled: true, songsEvery: 5, timedEnabled: false, timedMinutes: 60 },
  microphone: { enabled: false, ducking: 35 },
  music: [{ id: 'm1', title: 'Bir Şarkı', artist: 'Bilinmeyen sanatçı', filename: 'a.mp3', durationSeconds: 200 }],
  ads: [],
  history: [],
  queues: { music: [], adCursor: 0 },
  ezan: { enabled: false, active: false, times: {}, il: 'İstanbul' },
  current: { id: 'm1', title: 'Bir Şarkı', artist: 'Bilinmeyen sanatçı', durationSeconds: 200 },
  nextMusic: [],
  listeners: 3,
  timing: { serverNow: Date.now(), targetLatencySeconds: 2 },
  network: { ip: '192.168.1.14', ips: [{ ip: '192.168.1.14', name: 'Ethernet' }], preferredIp: null, preferredMissing: false, reachedVia: [], webUrl: 'http://192.168.1.14:8090/listen', adminUrl: 'https://192.168.1.14:8443/listen', streamUrl: 'http://192.168.1.14:8090/live.mp3' },
  capabilities: { message: 'Yerel MP3 yayın motoru aktif.' },
  ...overrides
})

// Serves the station payload to whatever the component fetches, and keeps the EventSource
// the page opens from exploding in jsdom.
function mockNetwork(payload = station()) {
  globalThis.fetch = vi.fn(async (url) => {
    const body = String(url).includes('/api/qr') ? { dataUrl: 'data:image/png;base64,AAAA' } : payload
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
  })
  class FakeEventSource {
    constructor() { this.close = () => {} }
  }
  globalThis.EventSource = FakeEventSource
}

beforeEach(() => { localStorage.clear(); mockNetwork() })
afterEach(() => cleanup())

describe('Dinleyici sayfası', () => {
  test('ilk açılışta ses %100 gelir, %0 değil', async () => {
    // THE regression: `Number(null)` is 0, so an unset store used to read as "volume 0" and
    // every phone opening the page for the first time started silent with the slider at 0%.
    render(<Listener />)
    const slider = await screen.findByRole('slider', { name: /ses/i })
    expect(Number(slider.value)).toBe(100)
    expect(screen.getByText('100%')).toBeDefined()
  })

  test('kayıtlı ses seviyesi geri yüklenir', async () => {
    localStorage.setItem('cr_listen_vol', '42')
    render(<Listener />)
    const slider = await screen.findByRole('slider', { name: /ses/i })
    expect(Number(slider.value)).toBe(42)
  })

  test('bozuk kayıtlı değer varsayılana düşer', async () => {
    // A store can hold anything — a half-written value, something from an older build.
    localStorage.setItem('cr_listen_vol', 'abc')
    render(<Listener />)
    const slider = await screen.findByRole('slider', { name: /ses/i })
    expect(Number(slider.value)).toBe(100)
  })

  test('dinleyici sayısı gösterilir', async () => {
    render(<Listener />)
    expect(await screen.findByText(/3 kişi dinliyor/)).toBeDefined()
  })

  test('ezan aktifken açıklama gösterilir', async () => {
    mockNetwork(station({ ezan: { enabled: true, active: true, activePrayer: 'Öğle', times: {}, il: 'İstanbul' } }))
    render(<Listener />)
    // The customer must be told why the music stopped, or it reads as a fault.
    expect(await screen.findByText(/Ezan Vakti/i)).toBeDefined()
    expect(screen.getByText(/otomatik devam/i)).toBeDefined()
  })

  test('yönetici paneli kilitliyken gösterilmez', async () => {
    render(<Listener />)
    await screen.findByRole('slider', { name: /ses/i })
    // A customer must not see the transport controls.
    expect(screen.queryByText('STOP')).toBeNull()
    expect(screen.queryByText(/Reklam Çal/)).toBeNull()
  })
})

describe('Bağlantı kartı (iki ağlı kafe)', () => {
  test('tek adres varken seçici gösterilmez', async () => {
    render(<ConnectCard station={station()} />)
    expect(await screen.findByText('http://192.168.1.14:8090/listen')).toBeDefined()
    expect(screen.queryByText(/deneyebileceğiniz adresler/i)).toBeNull()
  })

  test('iki adres varken hepsi denenmek üzere listelenir', async () => {
    // The station listens on every address; the QR can only show one. With two networks the
    // fastest fix is trying each on a phone, so the panel has to show them all.
    const two = station()
    two.network.ips = [{ ip: '192.168.1.14', name: 'Ethernet' }, { ip: '192.168.68.155', name: 'Wi-Fi' }]
    const { container } = render(<ConnectCard station={two} />)
    expect(await screen.findByText(/deneyebileceğiniz adresler/i)).toBeDefined()
    // Scoped to the list itself: the addresses also appear in the QR link and the selector,
    // so a page-wide search would match several elements and prove nothing about the list.
    const listed = [...container.querySelectorAll('.all-urls code')].map(el => el.textContent)
    expect(listed.length).toBe(2)
    expect(listed.some(t => t.includes('192.168.68.155:8090/listen'))).toBe(true)
    expect(listed.some(t => t.includes('192.168.1.14:8090/listen'))).toBe(true)
    // Each entry names its adapter, so the operator can tell the two networks apart.
    expect(listed.some(t => /Wi-Fi/.test(t))).toBe(true)
  })

  test('kayıtlı adres kaybolduysa uyarı gösterilir', async () => {
    const stale = station()
    stale.network.ips = [{ ip: '192.168.1.14', name: 'Ethernet' }, { ip: '10.0.0.5', name: 'Wi-Fi' }]
    stale.network.preferredIp = '192.168.68.155'
    stale.network.preferredMissing = true
    render(<ConnectCard station={stale} />)
    expect(await screen.findByText(/artık yok/i)).toBeDefined()
  })

  test('telefonların ulaştığı adres bildirilir', async () => {
    // Evidence instead of guesswork: this is what tells the operator which address works.
    const reached = station()
    reached.network.ips = [{ ip: '192.168.1.14', name: 'Ethernet' }, { ip: '192.168.68.155', name: 'Wi-Fi' }]
    reached.network.reachedVia = [{ ip: '192.168.68.155', lastAt: new Date().toISOString() }]
    const { container } = render(<ConnectCard station={reached} />)
    const note = await screen.findByText(/üzerinden bağlandı/i)
    expect(note.textContent).toContain('192.168.68.155')
    // The QR is pointing somewhere else, and the operator has to be told to switch.
    expect(note.textContent).toMatch(/başka bir adresi gösteriyor/i)
    expect(container.querySelector('.reached-note')).not.toBeNull()
  })

  test('QR zaten doğru adresi gösteriyorsa uyarı eklenmez', async () => {
    // The nudge must disappear once there is nothing to fix, or it becomes noise the
    // operator learns to ignore.
    const agreeing = station()
    agreeing.network.ip = '192.168.68.155'
    agreeing.network.ips = [{ ip: '192.168.1.14', name: 'Ethernet' }, { ip: '192.168.68.155', name: 'Wi-Fi' }]
    agreeing.network.reachedVia = [{ ip: '192.168.68.155', lastAt: new Date().toISOString() }]
    render(<ConnectCard station={agreeing} />)
    const note = await screen.findByText(/üzerinden bağlandı/i)
    expect(note.textContent).not.toMatch(/başka bir adresi gösteriyor/i)
  })

  test('hiç telefon bağlanmadıysa ne yapılacağı söylenir', async () => {
    const none = station()
    none.network.ips = [{ ip: '192.168.1.14', name: 'Ethernet' }, { ip: '10.0.0.5', name: 'Wi-Fi' }]
    render(<ConnectCard station={none} />)
    expect(await screen.findByText(/Henüz hiçbir telefon bağlanamadı/i)).toBeDefined()
    expect(screen.getByText(/aynı Wi/i)).toBeDefined()
  })
})

describe('Güncelleme kartı', () => {
  const updateState = over => ({ supported: true, version: '0.3.2', checking: false, available: false, downloading: false, percent: 0, downloaded: false, newVersion: null, error: null, ...over })

  const mockUpdate = payload => {
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) }))
  }

  test('güncelleme kapalı kurulumda buton gösterilmez', async () => {
    mockUpdate({ supported: false, version: '0.3.2', reason: 'Bu kurulumda güncelleme kapalı' })
    render(<UpdateCard />)
    expect(await screen.findByText(/güncelleme kapalı/i)).toBeDefined()
    expect(screen.queryByText(/Şimdi Güncelle/)).toBeNull()
  })

  test('indirme sürerken yüzde gösterilir, buton çıkmaz', async () => {
    mockUpdate(updateState({ downloading: true, percent: 62, newVersion: '0.3.3' }))
    render(<UpdateCard />)
    expect(await screen.findByText(/%62/)).toBeDefined()
    expect(screen.queryByText(/Şimdi Güncelle/)).toBeNull()
  })

  test('indirme bitince güncelle butonu çıkar', async () => {
    mockUpdate(updateState({ downloaded: true, percent: 100, newVersion: '0.3.3' }))
    render(<UpdateCard />)
    expect(await screen.findByText(/Şimdi Güncelle/)).toBeDefined()
    expect(screen.getByText(/0\.3\.3/)).toBeDefined()
    // The operator must know the broadcast will be interrupted BEFORE clicking.
    expect(screen.getByText(/yayın kısa süre kesilir/i)).toBeDefined()
  })

  test('güncelleme hatası gizlenmez', async () => {
    mockUpdate(updateState({ error: 'Ağ hatası: GitHub erişilemedi' }))
    render(<UpdateCard />)
    expect(await screen.findByText(/GitHub erişilemedi/)).toBeDefined()
  })
})
