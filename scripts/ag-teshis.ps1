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

Head "3b) KURAL, BU AGDA GECERLI MI?"
# The two facts above are useless apart. A rule that exists but is scoped to 'Private' does
# nothing on a network Windows has filed as 'Public' - and that is exactly what a NEW router
# produces: Windows sees an unfamiliar network, files it as Public by default, and a station
# that worked for months stops accepting connections without a single setting having changed.
# The symptom is precisely "the address is right and the page never loads".
$profiles = Get-NetConnectionProfile | Where-Object { $_.IPv4Connectivity -ne 'Disconnected' }
if (-not $rules) {
  "!! Kural yok - bu bolumun anlami kalmiyor, once kurulumu yonetici olarak calistirin."
} elseif (-not $profiles) {
  "Aktif ag profili bulunamadi."
} else {
  foreach ($p in $profiles) {
    $kat = "$($p.NetworkCategory)"          # Public / Private / DomainAuthenticated
    $kapsayan = $rules | Where-Object {
      $_.Enabled -eq 'True' -and $_.Action -eq 'Allow' -and
      ("$($_.Profile)" -eq 'Any' -or "$($_.Profile)" -match $kat -or
       ($kat -eq 'DomainAuthenticated' -and "$($_.Profile)" -match 'Domain'))
    }
    if ($kapsayan) {
      "OK  '$($p.Name)' ($kat) -> bu agi kapsayan kural var: $(($kapsayan | Select-Object -First 1).DisplayName)"
    } else {
      "!!  '$($p.Name)' ($kat) -> BU AGI KAPSAYAN ACIK KURAL YOK."
      "    Telefonlar bu agdan baglanamaz. Iki cozumden biri:"
      "      a) Bu agi 'Ozel' (Private) yapin:  Ayarlar > Ag ve Internet > (ag adi) > Ozel ag"
      "      b) Ya da kurali bu profile de acin (yonetici PowerShell):"
      "         Set-NetFirewallRule -DisplayName '$(($rules | Select-Object -First 1).DisplayName)' -Profile Any"
    }
  }
}

Head "4) UYGULAMA CALISIYOR MU"
# The port is not always 8090 - PORT can change it - so ask the app rather than assume.
$port = 8090
try {
  $s = Invoke-RestMethod 'http://127.0.0.1:8090/api/state' -TimeoutSec 3
  if ($s.network.port) { $port = $s.network.port }
} catch { }
$listen = Get-NetTCPConnection -LocalPort $port -State Listen -EA SilentlyContinue
if ($listen) {
  "EVET - $port portu dinleniyor:"
  $listen | Select-Object @{n='Dinlenen adres';e={$_.LocalAddress}}, @{n='Port';e={$_.LocalPort}} |
    Format-Table -AutoSize | Out-String
  "('0.0.0.0' ya da '::' = tum aglardan kabul ediyor, dogrusu budur.)"
  # Windows lets two processes share a port when neither asks for exclusivity, and then half
  # the phones reach a station with no music in it. The app now refuses that bind, but an
  # older copy still running from before the fix would not.
  $sahipler = $listen | Select-Object -ExpandProperty OwningProcess -Unique
  if ($sahipler.Count -gt 1) {
    "!! DIKKAT: bu portu $($sahipler.Count) AYRI PROGRAM dinliyor - iki kopya birden calisiyor olabilir."
    $sahipler | ForEach-Object {
      $pr = Get-Process -Id $_ -EA SilentlyContinue
      "   PID $_  $(if($pr){$pr.ProcessName}else{'(bilinmiyor)'})"
    }
    "   Cozum: Gorev Yoneticisi'nden tum 'Rovli Radyo' kopyalarini kapatip tek kez acin."
  }
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
