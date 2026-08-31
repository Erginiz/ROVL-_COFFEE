# Rovli Radyo

Bir kafenin kendi müzik ve anons sistemi. Kafedeki bilgisayar radyo istasyonu olur;
müşteriler QR kodu okutup **kendi telefonlarından** aynı yayını dinler. İnternet gerekmez —
her şey kafenin kendi Wi‑Fi ağında çalışır.

```
Kafe bilgisayarı                 Telefonlar
┌──────────────────┐            ┌──────────┐
│ Müzik + Reklam   │  Wi-Fi     │  QR oku  │
│ ffmpeg → MP3 ────┼───────────▶│  dinle   │
│ Yönetim paneli   │            └──────────┘
└──────────────────┘
```

## Ne yapar

- **Kesintisiz yayın.** Tek bir MP3 kodlayıcı sürekli çalışır; parça değişimi, ses ayarı,
  duraklatma ve anons sırasında bile bağlantı kopmaz. Telefonlar yeniden bağlanmak zorunda
  kalmaz.
- **Reklam otomasyonu.** Her N şarkıda bir ya da her N dakikada bir; elle de çalınabilir.
- **Ezan vakti duraklatma.** Vakitler otomatik alınır, müzik o süre boyunca susar, sonra
  kaldığı yerden devam eder. Operatör isterse o vakti iptal edebilir.
- **Canlı anons.** Telefondan ya da bilgisayardan mikrofonla konuşma; müzik anons boyunca
  kısılır.
- **Ses eşitleme.** Her parçanın gerçek gürlüğü ölçülür (LUFS) ve tek tek dengelenir —
  bir şarkı duyulmazken diğerinin bağırmasını önler.
- **Uygulama içi güncelleme.** Yeni sürüm arka planda iner, operatör uygun bir anda tek
  düğmeyle kurar.

## Çalıştırma

```bash
npm install
npm run dev        # sunucu + arayüz + masaüstü penceresi
```

Yalnızca sunucu: `npm start` → `http://127.0.0.1:8090`

| Adres | Kim için |
|---|---|
| `/admin` | Kafe bilgisayarındaki yönetim paneli |
| `/listen` | Telefonlar (QR bu adrese gider) |
| `/live.mp3` | Canlı ses akışı |

## Test

```bash
npm test           # tamamı (sunucu + arayüz)
npm run test:server
npm run test:ui
```

Testler gerçek ffmpeg ve gerçek bir sunucuyla çalışır: her test kendi geçici veri klasörünü
ve portunu alır, kafenin gerçek kütüphanesine dokunmaz. Bunun sebebi basit — bu projede
bulunan hataların çoğu süreç yaşam döngüsü ve zamanlama hatalarıydı ve sahte nesnelerle
yeniden üretilemiyorlardı.

Kapsam: dayanıklılık (kodlayıcı çökmesi, bozuk dosya, port çakışması, depolama arızaları),
güvenlik (yönetici yetkisi, CSRF, HTTPS sertifikası, açık uç yüzeyi), ses motoru (mikser,
limiter, tampon kuyruğu), eşzamanlılık ve arayüz.

## Kurulum paketi

```bash
npm run pack       # testler geçmeden paket üretilmez
```

`release/RovliRadyoSetup-<sürüm>.exe` oluşur. Güncelleme yayınlama adımları:
[docs/guncelleme.md](docs/guncelleme.md)

## Ağ sorunlarında

Kafede telefonlar bağlanamıyorsa, o bilgisayarda PowerShell'i **yönetici olarak** açıp:

```bash
irm https://raw.githubusercontent.com/Erginiz/ROVL-_COFFEE/main/scripts/ag-teshis.ps1 | iex
```

Kafedeki bilgisayarda bu depo yok — kurulu uygulama var. Bu yüzden komut dosyayı
doğrudan indirip çalıştırır; deponun elinizde olmasını gerektiren
`-File scripts/ag-teshis.ps1` biçimi orada işe yaramaz. (Depoyu klonladıysanız o da
çalışır: `powershell -ExecutionPolicy Bypass -File scripts/ag-teshis.ps1`.)

Onbeş bölümde topladığı bilgiden (adaptörler, IP/ağ geçidi/DNS, varsayılan rotalar, Wi-Fi,
sanal ve VPN adaptörleri, ağ profilleri, güvenlik duvarı, üçüncü parti güvenlik yazılımı,
süreçler, portlar, her adreste erişim testi, uygulamanın kendi durumu ve arıza günlüğü,
ağda görünen cihazlar, proxy/hosts) **sıralı bir "muhtemel sebep" listesi** çıkarır.
Ayırt ettikleri arasında: güvenlik duvarı izni hiç yok mu, izin var ama bu ağı kapsamıyor
mu, portu iki program birden mi dinliyor, bilgisayar iki ağa birden mi bağlı, telefonlar bu
ağda hiç görünüyor mu. Her birinin çözümü farklıdır ve çıktı hangisi olduğunu söyler.

Hepsi elenirse geriye kalanı da söyler — misafir ağı ya da router'daki istemci izolasyonu.

**Bulduğu sorunu düzeltebilir**, ama hiçbir şeyi size sormadan yapmaz: çalıştıracağı komutu
gösterir, tek tek onayınızı alır (Enter'a basmak "hayır" demektir) ve yaptığı her değişikliği
raporun sonuna yazar. Düzeltme için yönetici hakkı gerekir; olmadan da teşhisin tamamı çıkar.

Tam rapor masaüstüne `rovli-ag-raporu-<tarih>.txt` olarak kaydedilir — ekrandan kopyalamanıza
gerek yok, o dosyayı gönderin yeter.

Betiğin kendi karar mantığının testleri var: `ag-teshis.ps1 -Test`.

## Yapı

| Dosya | Ne yapar |
|---|---|
| `server/index.cjs` | HTTP/HTTPS sunucu, kütüphane, reklam ve ezan zamanlaması, yetkilendirme |
| `server/audio-engine.cjs` | Kalıcı MP3 kodlayıcı, parça çözücüler, mikser, izleme köpekleri |
| `server/ezan-window.cjs` | Vakit penceresi hesabı (gece yarısını aşan durumlar dahil) |
| `electron/main.cjs` | Masaüstü penceresi, güncelleyici, düzgün kapanış |
| `src/main.jsx` | Yönetim paneli ve dinleyici sayfası (React) |

**Veriler asla depoya girmez.** Müzikler, ayarlar, yönetici kodu ve HTTPS anahtarı
`%APPDATA%\rovli-radyo\data` altında, kafenin kendi bilgisayarında durur.
