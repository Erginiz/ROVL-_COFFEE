// The admin panel drives a café that is playing music to paying customers. Its dangerous
// failure mode is not a crash — it is a control that looks like it worked and did not: a
// button press swallowed by an expired session, a code shown to someone who should not see
// it, a confirmation that never appeared before something irreversible happened.

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { AdminCodeCard, EzanCard, MasterBar, TrackList, Status, ErrorBoundary } from '../../src/main.jsx'

const baseStation = (overrides = {}) => ({
  station: { name: 'Rovli Radyo' },
  playback: { status: 'playing', currentId: 'm1', currentType: 'music', musicVolume: 76, adVolume: 90, shuffle: true, currentOffsetSeconds: 0, currentStartedAt: new Date().toISOString() },
  adSettings: { songsEnabled: true, songsEvery: 5, timedEnabled: false, timedMinutes: 60 },
  microphone: { enabled: false, ducking: 35 },
  music: [{ id: 'm1', title: 'Bir Şarkı', durationSeconds: 200 }, { id: 'm2', title: 'Başka Şarkı', durationSeconds: 180 }],
  ads: [],
  history: [],
  queues: { music: [], adCursor: 0 },
  ezan: { enabled: false, active: false, times: {}, il: 'İstanbul', ilce: '', durationMinutes: 8, lastError: null },
  current: { id: 'm1', title: 'Bir Şarkı', artist: 'Bilinmeyen sanatçı', durationSeconds: 200 },
  listeners: 0,
  network: { ip: '192.168.1.14', ips: [], reachedVia: [], webUrl: 'http://192.168.1.14:8090/listen', adminUrl: 'https://192.168.1.14:8443/listen', streamUrl: 'http://192.168.1.14:8090/live.mp3' },
  timing: { targetLatencySeconds: 2 },
  capabilities: { message: 'aktif' },
  ...overrides
})

const jsonFetch = payload => vi.fn(async () => ({
  ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload)
}))

beforeEach(() => { localStorage.clear() })
afterEach(() => cleanup())

describe('Yönetici kodu kartı', () => {
  test('kod varsayılan olarak gizlidir', async () => {
    // The panel sits on the café counter in view of customers.
    globalThis.fetch = jsonFetch({ code: '482913', fromEnv: false })
    render(<AdminCodeCard />)
    expect(await screen.findByText('••••••')).toBeDefined()
    expect(screen.queryByText('482913')).toBeNull()
  })

  test('göster denince kod açılır', async () => {
    globalThis.fetch = jsonFetch({ code: '482913', fromEnv: false })
    render(<AdminCodeCard />)
    fireEvent.click(await screen.findByText('Göster'))
    expect(await screen.findByText('482913')).toBeDefined()
  })

  test('yeni kod üretmeden önce onay istenir', async () => {
    // Rotating logs every unlocked phone out; doing that on a stray click during service
    // would strand whoever is running the music from their phone.
    globalThis.fetch = jsonFetch({ code: '482913', fromEnv: false })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<AdminCodeCard />)
    fireEvent.click(await screen.findByText(/Yeni Kod/i))
    expect(confirmSpy).toHaveBeenCalled()
    expect(confirmSpy.mock.calls[0][0]).toMatch(/yetkisi kalkar|giriş yapmış/i)
  })
})

describe('Ezan kartı', () => {
  test('kapalıyken ayar alanları gizli', () => {
    render(<EzanCard station={baseStation()} save={vi.fn()} />)
    expect(screen.queryByLabelText('İl')).toBeNull()
  })

  test('açıkken il, ilçe ve süre ayarlanabilir', () => {
    const station = baseStation({ ezan: { enabled: true, active: false, times: {}, il: 'İstanbul', ilce: '', durationMinutes: 8, lastError: null } })
    render(<EzanCard station={station} save={vi.fn()} />)
    expect(screen.getByLabelText('İl')).toBeDefined()
    expect(screen.getByLabelText('İlçe')).toBeDefined()
    expect(screen.getByLabelText(/Durma süresi/)).toBeDefined()
  })

  test('vakitler alınamadıysa sebebi gösterilir', () => {
    // Otherwise the feature is simply "not working" with nothing to act on.
    const station = baseStation({
      ezan: { enabled: true, active: false, times: {}, il: 'İstanbul', ilce: '', durationMinutes: 8, lastError: 'HTTP 500' }
    })
    render(<EzanCard station={station} save={vi.fn()} />)
    expect(screen.getByText(/Vakitler alınamadı/i)).toBeDefined()
    expect(screen.getByText(/HTTP 500/)).toBeDefined()
  })

  test('vakitler geldiyse listelenir', () => {
    const station = baseStation({
      ezan: { enabled: true, active: false, times: { Sabah: '04:39', Öğle: '13:19' }, il: 'İstanbul', ilce: '', durationMinutes: 8, lastError: null }
    })
    render(<EzanCard station={station} save={vi.fn()} />)
    expect(screen.getByText('04:39')).toBeDefined()
    expect(screen.getByText('13:19')).toBeDefined()
  })

  test('açma/kapama sunucuya iletilir', () => {
    const save = vi.fn()
    render(<EzanCard station={baseStation()} save={save} />)
    fireEvent.click(screen.getByLabelText(/Ezan vaktinde/i))
    expect(save).toHaveBeenCalledWith({ ezan: { enabled: true } })
  })
})

describe('Yayın sesi çubukları', () => {
  test('mevcut seviyeler gösterilir', () => {
    render(<MasterBar station={baseStation()} control={vi.fn()} />)
    expect(screen.getByLabelText(/Müzik Sesi/i).value).toBe('76')
    expect(screen.getByLabelText(/Reklam Sesi/i).value).toBe('90')
  })

  test('sürgü sürüklenirken ses anında takip eder ama istekler kısılır', async () => {
    // Deliberately a THROTTLE, not a debounce (see VolumeRow): debouncing meant the sound
    // only changed once the operator let go, which feels broken when you are trying to find
    // the right level by ear. So the first move goes out immediately, and the rest are
    // rate-limited — every change is fanned out to every connected phone, and an unlimited
    // drag would flood the same Wi-Fi the music is streaming over.
    vi.useFakeTimers()
    const control = vi.fn()
    render(<MasterBar station={baseStation()} control={control} />)
    const slider = screen.getByLabelText(/Müzik Sesi/i)

    fireEvent.change(slider, { target: { value: 70 } })
    expect(control).toHaveBeenCalledWith('musicVolume', 70)   // heard at once

    // A burst of further movement must not become a burst of requests.
    for (const value of [65, 60, 55, 50, 45]) fireEvent.change(slider, { target: { value } })
    expect(control).toHaveBeenCalledTimes(1)

    // ...and the position the operator settled on still lands.
    vi.advanceTimersByTime(200)
    expect(control).toHaveBeenCalledTimes(2)
    expect(control).toHaveBeenLastCalledWith('musicVolume', 45)
    vi.useRealTimers()
  })

  test('100 üstü seviye vurgulanır (yükseltme yapıldığı belli olsun)', () => {
    // Past 100 the station is amplifying beyond the normalised level, which the limiter
    // absorbs — the operator should be able to see that they are in that range.
    render(<MasterBar station={baseStation({ playback: { musicVolume: 150, adVolume: 90 } })} control={vi.fn()} />)
    const shown = screen.getByText('150')
    expect(shown.className).toMatch(/boost/)
  })
})

describe('Parça listesi', () => {
  test('parçalar listelenir ve tıklanınca çalınır', () => {
    const onPlay = vi.fn()
    render(<TrackList title="Müzikler" items={baseStation().music} currentId="m1" playing onPlay={onPlay} />)
    fireEvent.click(screen.getByText('Başka Şarkı'))
    expect(onPlay).toHaveBeenCalledWith('m2')
  })

  test('kütüphane boşken ne yapılacağı söylenir', () => {
    render(<TrackList title="Müzikler" items={[]} currentId={null} playing={false} onPlay={vi.fn()} />)
    expect(screen.getByText(/Klasörü Aç/)).toBeDefined()
  })
})

describe('Hata sınırı', () => {
  test('bileşen çökerse beyaz ekran yerine kurtarma gösterilir', () => {
    // A render error must not leave the café looking at a blank screen with no way back.
    const Boom = () => { throw new Error('patladı') }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<ErrorBoundary><Boom /></ErrorBoundary>)
    expect(screen.getByText(/arayüz hatası/i)).toBeDefined()
    expect(screen.getByText(/Yeniden Yükle/)).toBeDefined()
    spy.mockRestore()
  })
})

describe('Şimdi çalıyor', () => {
  test('çalan parçanın adı gösterilir', () => {
    render(<Status station={baseStation()} />)
    expect(screen.getByText('Bir Şarkı')).toBeDefined()
  })

  test('hiçbir şey çalmıyorsa yönlendirme metni çıkar', () => {
    render(<Status station={baseStation({ current: null })} />)
    expect(screen.getByText(/Müzik ekleyerek başlayın/)).toBeDefined()
  })
})
