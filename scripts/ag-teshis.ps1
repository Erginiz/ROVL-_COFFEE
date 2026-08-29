# Rovli Radyo - ag teshis
#
# Telefonlar radyoya baglanamadiginda, sorunun nerede oldugunu tek seferde gosterir.
# Kafedeki bilgisayarda calistirin (uygulama ACIKKEN), ciktiyi kopyalayip gonderin.
#
# Calistirmak icin: bu dosyaya sag tik -> "PowerShell ile calistir"
# ya da PowerShell'de:  powershell -ExecutionPolicy Bypass -File ag-teshis.ps1
#
# Hicbir ayari DEGISTIRMEZ; sadece okur ve yazdirir.

$ErrorActionPreference = 'SilentlyContinue'
$sep = '=' * 62
function Head($t) { ""; $sep; " $t"; $sep }

Head "1) BU BILGISAYARIN AG ADRESLERI"
"Telefonlar bunlardan BIRINE ulasabilmeli."
Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notlike '127.*' } |
  Select-Object @{n='Adres';e={$_.IPAddress}}, @{n='Baglanti';e={$_.InterfaceAlias}} |
  Format-Table -AutoSize | Out-String
"NOT: 169.254.x.x bir adres DEGILDIR - o baglanti agdan IP alamamis demektir."

Head "2) AG PROFILLERI"
"'Public' olan bir agda Windows gelen baglantilari daha cok kisitlar."
Get-NetConnectionProfile |
  Select-Object @{n='Ag';e={$_.Name}}, @{n='Baglanti';e={$_.InterfaceAlias}}, @{n='Tur';e={$_.NetworkCategory}} |
  Format-Table -AutoSize | Out-String

Head "3) GUVENLIK DUVARI KURALLARI"
"Kurulum bunlari ekler. Yoksa telefonlar hicbir sekilde baglanamaz."
$rules = Get-NetFirewallRule -Direction Inbound -EA SilentlyContinue |
  Where-Object { $_.DisplayName -match 'Rovli|Cafe Radio' }
if ($rules) {
  $rules | Select-Object @{n='Kural';e={$_.DisplayName}}, @{n='Acik';e={$_.Enabled}}, @{n='Islem';e={$_.Action}}, @{n='Profil';e={$_.Profile}} |
    Format-Table -AutoSize | Out-String
} else {
  "!! KURAL BULUNAMADI - kurulumu yonetici olarak tekrar calistirin."
}

Head "4) UYGULAMA CALISIYOR MU"
$listen = Get-NetTCPConnection -LocalPort 8090 -State Listen -EA SilentlyContinue
if ($listen) {
  "EVET - 8090 portu dinleniyor:"
  $listen | Select-Object @{n='Dinlenen adres';e={$_.LocalAddress}}, @{n='Port';e={$_.LocalPort}} |
    Format-Table -AutoSize | Out-String
  "('0.0.0.0' = tum aglardan kabul ediyor, dogrusu budur.)"
} else {
  "!! HAYIR - uygulama kapali ya da baslamamis. Once Rovli Radyo'yu acin."
}

Head "5) UYGULAMANIN KENDI GORDUGU DURUM"
try {
  $state = Invoke-RestMethod 'http://127.0.0.1:8090/api/state' -TimeoutSec 5
  $net = $state.network
  "QR kodun gosterdigi adres : $($net.ip)"
  "Secili (tercih edilen)    : $(if($net.preferredIp){$net.preferredIp}else{'(secilmemis - otomatik)'})"
  if ($net.preferredMissing) { "!! Secili adres bu bilgisayarda ARTIK YOK." }
  "Uygulamanin gordugu adresler:"
  $net.ips | ForEach-Object { "   - $($_.ip)  ($($_.name))" }
  ""
  if ($net.reachedVia -and $net.reachedVia.Count -gt 0) {
    "TELEFONLAR SU ADRES(LER) UZERINDEN ULASTI:"
    $net.reachedVia | ForEach-Object { "   -> $($_.ip)   (son: $($_.lastAt))" }
    $ok = $net.reachedVia | Where-Object { $_.ip -eq $net.ip }
    if (-not $ok) { "!! QR baska bir adresi gosteriyor. Panelden yukaridaki adresi secin." }
  } else {
    "Hicbir telefon henuz ulasamadi."
    "  -> Telefonun bu bilgisayarla AYNI Wi-Fi agina bagli oldugundan emin olun."
    "  -> Iki router varsa, telefon ile bilgisayar ayni router'a bagli olmali."
  }
  "Dinleyici sayisi: $($state.listeners)"
} catch {
  "!! Uygulamaya baglanilamadi (http://127.0.0.1:8090). Acik oldugundan emin olun."
}

Head "6) TELEFONUN DENEYECEGI ADRESLER"
"Telefonun tarayicisina bunlari tek tek yazip deneyin:"
Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
  ForEach-Object { "   http://$($_.IPAddress):8090/listen   ($($_.InterfaceAlias))" }

""
$sep
" Bu ciktinin TAMAMINI kopyalayip gonderin."
$sep
""
Read-Host "Kapatmak icin Enter'a basin"
