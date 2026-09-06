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

  test('fazlalık birikince hızlanır', () => {
    // Eskiden bu test 2 saniyelik payla hızlanmayı bekliyordu. Yanlıştı: 2 saniye sağlıklı
    // bir tampondur, gecikme değil. Hızlanmak ancak gerçekten fazlalık varken doğru.
    const action = liveEdgeAction(10, 1)
    expect(action.seek).toBe(false)
    expect(action.rate).toBeGreaterThan(1)
    expect(action.rate).toBeLessThan(1.1)
  })

  test('devasa fazlalık hızlanmayla değil atlayarak kapatılır', () => {
    // 25 saniyeyi %3 ile eritmek ~14 dakika sürer ve o süre boyunca ses tiz kalır.
    const action = liveEdgeAction(25, 1.03)
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
    // Eşiğin çevresinde gezinen bir oynatıcı her tikte hız değiştirirse, düzeltmeye
    // çalıştığı kaymadan çok daha fazla duyulur. Bant artık RELAX(6) ile CATCHUP(8) arası.
    expect(liveEdgeAction(7, 1.03).rate).toBe(1.03)
    expect(liveEdgeAction(7, 1).rate).toBe(1)
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
    for (let behind = 0; behind < 30; behind += 0.1) {
      const action = liveEdgeAction(behind, 1)
      if (firstSpeedUp === null && action.rate > 1) firstSpeedUp = behind
      if (firstSeek === null && action.seek) firstSeek = behind
    }
    expect(firstSpeedUp).not.toBeNull()
    expect(firstSeek).not.toBeNull()
    expect(firstSeek).toBeGreaterThan(firstSpeedUp)
  })
})

// ÖLÇÜLEN GERÇEK: çalışan istasyonda panelin ses elemanı izlendi. `buffered.end() -
// currentTime` sürekli 1.9–4.0 sn arasında salınıyor ve hiç 0.5'in altına inmiyor. Eski
// mantık bunu "geride kaldık" okuyup hızı 1.03'e kilitliyordu; %3 hızlı çalmak sesi
// sunucunun ürettiğinden hızlı tüketiyor, tampon boşalıyor (ölçüldü: geride 0.07),
// `waiting` yağıyor ve panel "Bağlanıyor…" yazıyor. 12 saniyede 4 kesinti sayıldı;
// hız 1'e sabitlenince aynı ölçüm 74 saniyede 1'e düştü.
//
// Yani bu değer gecikme DEĞİL, tampon payı: oynatma kafasının önündeki ses. 2–4 saniye
// olması sağlıklıdır — jitter'a karşı koruma tam olarak odur. Onu tüketmek, önlemesi
// beklenen kesintiyi üretir.
describe('Tampon payı gecikme sanılmamalı', () => {
  test('sağlıklı 2-4 sn tampon hızlanmayı tetiklemez', () => {
    // Çalışan istasyondan alınan gerçek örnekler.
    for (const olculen of [1.88, 2.11, 2.39, 2.91, 3.17, 3.42, 3.92, 4.05]) {
      const karar = liveEdgeAction(olculen, 1)
      expect(karar.rate).toBe(1)
      expect(karar.seek).toBe(false)
    }
  })

  test('hızlanmış oynatıcı sağlıklı tamponda normale döner', () => {
    // Eski kodun asıl kusuru: 1.03'e çıkıp bir daha inmemesi.
    expect(liveEdgeAction(2.4, 1.03).rate).toBe(1)
  })

  test('tampon incelirken asla hızlanılmaz', () => {
    // Tampon zaten tükeniyorken hızlanmak underrun'ı garantiler.
    for (const kritik of [0.07, 0.3, 0.9]) {
      expect(liveEdgeAction(kritik, 1.03).rate).toBe(1)
    }
  })

  test('yalnızca gerçekten fazla tampon birikince hızlanılır', () => {
    // Fazlalık varsa harcanacak bir şey var demektir; ancak o zaman hızlanmak güvenli.
    expect(liveEdgeAction(12, 1).rate).toBeGreaterThan(1)
  })
})
