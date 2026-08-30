// The station records everything worth knowing — a file it cannot read, a track it skipped,
// an engine that restarted itself, an ezan pause the operator cancelled — and until this card
// existed it showed none of it. That made every failure look identical from the counter:
// something is wrong, with no way to find out what.
//
// So this is not decoration. Several fixes in this project end with "and the operator can see
// why in the history"; without a view, that sentence was false.

import { describe, test, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { HistoryCard, UpNext, ConnectCard } from '../../src/main.jsx'

const entry = (type, title, minutesAgo = 0) => ({
  id: `${type}-${title}-${minutesAgo}`,
  at: new Date(Date.now() - minutesAgo * 60000).toISOString(),
  type,
  title
})

const withHistory = history => ({ history })

afterEach(() => cleanup())

describe('İstasyon günlüğü', () => {
  test('sistem olayları varsayılan olarak gösterilir', () => {
    render(<HistoryCard station={withHistory([
      entry('system', 'Dosya okunamıyor, atlanacak: Bozuk Şarkı'),
      entry('system', 'Ses motoru hatası', 5)
    ])} />)
    expect(screen.getByText(/Dosya okunamıyor/)).toBeDefined()
    expect(screen.getByText(/Ses motoru hatası/)).toBeDefined()
  })

  test('varsayılan görünüm müzik gürültüsünü gizler', () => {
    // A café plays a few hundred tracks a day. If every one of them is listed, the one line
    // that matters is buried — which is the same as not showing it.
    render(<HistoryCard station={withHistory([
      entry('music', 'Müzik: Bir Şarkı'),
      entry('music', 'Müzik: Başka Şarkı', 3),
      entry('system', 'Parça çalınamadı, sonrakine geçildi', 5)
    ])} />)
    expect(screen.getByText(/Parça çalınamadı/)).toBeDefined()
    expect(screen.queryByText(/Müzik: Bir Şarkı/)).toBeNull()
  })

  test('"Tümü" ile çalma geçmişi de görülebilir', () => {
    render(<HistoryCard station={withHistory([
      entry('music', 'Müzik: Bir Şarkı'),
      entry('ad', 'Reklam: Kahve İndirimi', 2)
    ])} />)
    fireEvent.click(screen.getByText('Tümü'))
    expect(screen.getByText(/Müzik: Bir Şarkı/)).toBeDefined()
    expect(screen.getByText(/Reklam: Kahve İndirimi/)).toBeDefined()
  })

  test('anons kayıtları da olay sayılır', () => {
    // Announcements are operator actions; they belong next to the events, not in the music log.
    render(<HistoryCard station={withHistory([entry('microphone', 'Canlı mikrofon anonsu başlatıldı')])} />)
    expect(screen.getByText(/Canlı mikrofon anonsu/)).toBeDefined()
  })

  test('her kayıt saatiyle birlikte gösterilir', () => {
    // "When did that happen" is half the question the operator is asking.
    render(<HistoryCard station={withHistory([entry('system', 'Ezan duraklatması iptal edildi')])} />)
    const shown = screen.getByText(/Ezan duraklatması/)
    const row = shown.closest('.history-row')
    expect(row.querySelector('.history-time').textContent).toMatch(/^\d{2}:\d{2}$/)
  })

  test('olay yokken sakinleştirici bir mesaj gösterilir', () => {
    // An empty list should read as "nothing is wrong", not as "this feature is broken".
    render(<HistoryCard station={withHistory([entry('music', 'Müzik: Bir Şarkı')])} />)
    expect(screen.getByText(/her şey yolunda/i)).toBeDefined()
  })

  test('geçmiş hiç yokken çökmez', () => {
    render(<HistoryCard station={{}} />)
    expect(screen.getByText(/Kayda değer bir olay yok|Henüz kayıt yok/)).toBeDefined()
  })

  test('sistem olayları görsel olarak ayrışır', () => {
    // The operator scans this card looking for trouble; trouble has to stand out.
    const { container } = render(<HistoryCard station={withHistory([
      entry('system', 'Ses motoru çöktü, yeniden başlatıldı')
    ])} />)
    expect(container.querySelector('.history-row.system')).not.toBeNull()
  })

  test('uzun listede en yenisi üstte kalır', () => {
    const many = Array.from({ length: 60 }, (_, i) => entry('system', `Olay ${i}`, i))
    const { container } = render(<HistoryCard station={withHistory(many)} />)
    const rows = container.querySelectorAll('.history-row')
    expect(rows.length).toBeLessThanOrEqual(25)
    expect(rows[0].textContent).toContain('Olay 0')
  })
})

describe('Sırada listesi', () => {
  test('gelecek parçalar sırayla gösterilir', () => {
    // The data was already being computed and sent on every update and nothing displayed it.
    // Showing it answers a question the operator asks constantly — is the next song right for
    // the room? — while there is still time to change it.
    render(<UpNext station={{ nextMusic: [
      { id: 'a', title: 'İlk Şarkı' },
      { id: 'b', title: 'İkinci Şarkı' },
      { id: 'c', title: 'Üçüncü Şarkı' }
    ] }} />)
    expect(screen.getByText(/İlk Şarkı/)).toBeDefined()
    expect(screen.getByText(/Üçüncü Şarkı/)).toBeDefined()
  })

  test('en fazla beş parça gösterilir (panel dolmasın)', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ id: 'x' + i, title: 'Şarkı ' + i }))
    const { container } = render(<UpNext station={{ nextMusic: many }} />)
    expect(container.querySelectorAll('.up-next-item').length).toBe(5)
  })

  test('kuyruk boşken kart hiç gösterilmez', () => {
    // An empty "up next" box is noise on a panel the operator scans at a glance.
    const { container } = render(<UpNext station={{ nextMusic: [] }} />)
    expect(container.querySelector('.up-next')).toBeNull()
  })

  test('kuyruk bilgisi hiç yoksa çökmez', () => {
    const { container } = render(<UpNext station={{}} />)
    expect(container.querySelector('.up-next')).toBeNull()
  })
})

// The café's whole problem was phones being handed an address that did not work. The panel
// prints those addresses, and it printed the port as a literal ":8090" while the server
// published whatever port it had actually bound. Two sources of truth for the one string an
// operator reads out loud to a customer.
describe('Bağlantı adresleri', () => {
  const netStation = port => ({
    network: {
      ip: '192.168.1.14', port,
      ips: [{ ip: '192.168.1.14', name: 'Wi-Fi' }, { ip: '10.0.0.5', name: 'Ethernet' }],
      reachedVia: [], preferred: null, preferredMissing: false,
      webUrl: `http://192.168.1.14:${port}/listen`
    }
  })

  test('gösterilen adresler sunucunun gerçekten dinlediği portu kullanır', () => {
    const { container } = render(<ConnectCard station={netStation(9317)} />)
    const shown = [...container.querySelectorAll('code')].map(node => node.textContent).join(' ')
    expect(shown).toContain('9317')
    expect(shown).not.toContain('8090')
  })
})
