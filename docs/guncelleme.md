# Uygulama İçi Güncelleme

Kafedeki bilgisayar uzakta. Bu özellik olmadan her düzeltme, birinin oraya gidip 109 MB'lık
kurulum dosyasını çalıştırmasını gerektiriyordu — yani düzeltmeler kafeye ulaşmıyordu.

Artık: program GitHub Releases'i kendisi kontrol eder, yeni sürümü **arka planda indirir**,
ve panelde **"Şimdi Güncelle"** düğmesi belirir. Kurulumu kimse otomatik başlatmaz — çünkü
kurulum sırasında **yayın kesilir** ve Windows izin penceresi çıkar. O anı kafedeki kişi seçer.

---

## Bir kerelik kurulum (henüz yapılmadı)

1. **GitHub deposu aç** — `public` olmalı. Kaynak kodu paylaşmak zorunda değilsin; depo boş
   olabilir, önemli olan release dosyalarının erişilebilir olması. (Private depo, exe'nin
   içine token gömmeyi gerektirir — kabul edilemez.)
2. `package.json` içindeki `build.publish` alanını düzelt:
   ```json
   { "provider": "github", "owner": "GERÇEK-KULLANICI-ADI", "repo": "rovli-radyo" }
   ```
   Şu an `owner` alanı **`DEPO-SAHIBI`** yazıyor; gerçek kullanıcı adıyla değiştirilmeli.
3. GitHub hesabında **iki adımlı doğrulamayı aç.** Bu feed'i kontrol eden kişi, kafedeki
   bilgisayarda kod çalıştırabilir.

---

## Her yeni sürüm çıkarken

```
1. package.json → version yükselt (ör. 0.3.2 → 0.3.3)
2. npm test
3. npm run build
4. npx electron-builder --win nsis
```

`release/` klasöründen **üç dosyayı** GitHub'da yeni bir release'e yükle:

| Dosya | Ne işe yarar |
|---|---|
| `RovliRadyoSetup-<sürüm>.exe` | Kurulumun kendisi |
| `latest.yml` | **Zorunlu.** Program yeni sürümü bununla fark eder, SHA512 doğrulaması da burada |
| `RovliRadyoSetup-<sürüm>.exe.blockmap` | Fark indirmesi — ikinci güncellemeden sonra 109 MB yerine sadece değişen kısım iner |

Release etiketi **`v<sürüm>`** olmalı (ör. `v0.3.3`).

Kafedeki program en geç **6 saat** içinde görür; panelden "Güncelleme Denetle" ile hemen de
kontrol edilebilir.

---

## Kafedeki kişi ne görecek

Sağ sütunda **Program Sürümü** kartı:

- `Program güncel.` → yapacak bir şey yok
- `Yeni sürüm indiriliyor… %62` → beklesin, kendiliğinden iner
- `Yeni sürüm hazır: 0.3.3` + **Şimdi Güncelle** düğmesi

Düğmeye basınca uyarı çıkar: yayın birkaç dakika kesilecek, Windows izin penceresinde
**"Evet"** demek gerekiyor, kurulum bitince program kendiliğinden açılacak.

---

## Bilinmesi gerekenler

- **Kurulum imzasız.** İndirilen dosya `latest.yml`'deki SHA512 ile doğrulanır (bütünlük
  garanti), ama yayıncı kimliği doğrulanamadığı için Windows SmartScreen uyarı gösterebilir.
  Kod imzalama sertifikası alınırsa bu kalkar.
- **UAC:** Program `Program Files` altına kurulu olduğu için güncelleme yönetici izni ister.
- **Kurulumu yalnızca kafe bilgisayarı başlatabilir.** Telefondan sürüm görülebilir ama
  güncelleme başlatılamaz — masada unutulmuş bir telefon yayını kapatamasın diye.
- **Ağ yoksa hiçbir şey bozulmaz:** güncelleme kontrolü başarısız olur, panel sebebini yazar,
  müzik çalmaya devam eder.
