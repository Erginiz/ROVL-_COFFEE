# Rovli Radyo - ag teshis
#
# Kafedeki telefonlar radyoya baglanamadiginda, sebebini tek calistirmada bulmak icin.
#
#   Yonetici PowerShell'de:
#     irm https://raw.githubusercontent.com/Erginiz/ROVL-_COFFEE/main/scripts/ag-teshis.ps1 | iex
#
#   Ya da dosya elinizdeyse:
#     powershell -ExecutionPolicy Bypass -File ag-teshis.ps1
#
# HICBIR SEYI SIZE SORMADAN DEGISTIRMEZ. Once her seyi okur ve bir hukum verir; sadece
# bulduğu sorunun cozumunu, komutu gostererek ve tek tek onayinizi alarak uygular. Yaptigi
# her degisiklik raporun sonuna yazilir.
#
# Uzaktan teshiste asil maliyet gidis-gelis sayisidir: eksik her bilgi bir tur daha demek.
# Bu yuzden burasi bilerek ayrintili.
#
# NOT (gelistirici icin): bu dosyadaki METINLER bilerek ASCII. Konsolun kod sayfasi Turkce
# karakterleri bozuyor - ayni makinede "Bluetooth A? Ba?lant?s?" olarak olculdu. Windows'tan
# gelen veri bozulabilir, bizim yazdigimiz bozulmamali.
# Sozdizimi Windows PowerShell 5.1'e gore: ternary yok, ??' yok, -SkipCertificateCheck yok.

param([switch]$Test)

$ErrorActionPreference = 'SilentlyContinue'

# ==============================================================================
#  SAF KARAR FONKSIYONLARI
#  Disariya bagimli olmadiklari icin -Test ile dogrudan sinanabilirler. Bu proje icin
#  PowerShell test altyapisi yok; bu bolum, aksi halde hic sinanamayacak mantigin tek
#  gercek dogrulamasi.
# ==============================================================================

# Windows guvenlik duvari profilleri bir KUME: "Private, Domain" kapsamli bir kural her
# ikisinde de gecerlidir. Kurulumumuz "Any" yaziyor, ki hepsini kapsar - ama eski kurulumlar
# ve Windows'un kendi olusturdugu kurallar tek profile bagli olabiliyor.
function Test-RuleCoversCategory {
  param([string]$RuleProfile, [string]$Category)
  if (-not $Category) { return $false }
  if ($RuleProfile -eq 'Any' -or $RuleProfile -eq '') { return $true }
  # Kategori adi 'DomainAuthenticated', guvenlik duvari ayni seye 'Domain' diyor.
  if ($Category -eq 'DomainAuthenticated') { return ($RuleProfile -match '\bDomain\b') }
  # Kelime siniri: 'Public' baska bir profil adinin icinde bulunmasin, virgullu liste
  # uye uye eslessin.
  return ($RuleProfile -match ('\b' + [regex]::Escape($Category) + '\b'))
}

# Toplanan olgulardan sirali bir "muhtemel sebep" listesi. Sira kesinlikten belirsizlige:
# ustteki bulgu dogruysa alttakileri arastirmanin anlami yok.
function Get-Verdicts {
  param($F)
  $v = New-Object Collections.ArrayList

  if (-not $F.appRunning) {
    [void]$v.Add(@{ L='!!'; T="Rovli Radyo calismiyor - $($F.port) portunu kimse dinlemiyor."
                    F='Programi acin, sonra bu betigi tekrar calistirin.' })
    return $v   # program kapaliyken geri kalan her sey anlamsiz
  }

  if ($F.listenerPids.Count -gt 1) {
    [void]$v.Add(@{ L='!!'; T="Ayni portu $($F.listenerPids.Count) AYRI program dinliyor - iki kopya birden calisiyor."
                    F='Gorev Yoneticisi''nden tum kopyalari kapatip programi bir kez acin.'
                    Fix='kopya' })
  }

  if ($F.loopbackOk -and $F.lanOk.Count -eq 0 -and $F.lanIps.Count -gt 0) {
    [void]$v.Add(@{ L='!!'; T='Istasyon yalnizca kendi icinde cevap veriyor; ag adreslerinin hicbirinde cevap vermiyor.'
                    F='Bu bir sunucu tarafi arizasi. Ciktiyi gonderin.' })
  }

  if ($F.rules.Count -eq 0) {
    [void]$v.Add(@{ L='!!'; T='Windows guvenlik duvarinda bu programa ait ACIK bir izin yok.'
                    F='Kurulum yonetici hakki almadan yapilmis olabilir.'
                    Fix='kural-ekle' })
  } elseif ($F.uncovered.Count -gt 0) {
    $adlar = ($F.uncovered | ForEach-Object { "'$($_.Name)' ($($_.NetworkCategory))" }) -join ', '
    [void]$v.Add(@{ L='!!'; T="Izin var ama su agi KAPSAMIYOR: $adlar"
                    F='Ag "Ozel" yapilmali ya da kural tum profillere acilmali.'
                    Fix='kural-genislet' })
  }

  if ($F.apipaOnly) {
    [void]$v.Add(@{ L='!!'; T='Bu bilgisayar agdan IP alamamis (yalnizca 169.254.x.x adresi var).'
                    F='Ag kablosunu / Wi-Fi baglantisini kontrol edin.' })
  }

  if ($F.defaultRoutes.Count -gt 1) {
    $r = ($F.defaultRoutes | ForEach-Object { "$($_.InterfaceAlias)->$($_.NextHop)" }) -join ', '
    [void]$v.Add(@{ L='??'; T="Bilgisayar birden fazla aga birden bagli: $r"
                    F='Telefonlarin, istasyonun yayin yaptigi ADRESIN agina bagli oldugundan emin olun.' })
  }

  if ($F.neighborsOnSubnet -eq 0 -and $F.lanIps.Count -gt 0) {
    [void]$v.Add(@{ L='??'; T='Istasyonun agindaki baska hicbir cihaz gorunmuyor.'
                    F='Telefonlar buyuk olasilikla BASKA bir aga bagli.' })
  }

  if ($F.thirdPartyFw.Count -gt 0) {
    $ad = ($F.thirdPartyFw -join ', ')
    [void]$v.Add(@{ L='??'; T="Ucuncu parti guvenlik yazilimi kurulu: $ad"
                    F='Bu tur programlar Windows kuralini es gecip yerel agi kapatabilir; onun ayarlarina da bakin.' })
  }

  if ($F.state) {
    if ($F.state.network.preferredMissing) {
      [void]$v.Add(@{ L='??'; T='Panelde secili olan ag adresi bu bilgisayarda ARTIK YOK.'
                      F='Panelden listedeki gecerli bir adresi secin.' })
    }
    # F.reachedVia, betigin kendi erisim testinden ONCE alindi. state.network.reachedVia
    # su an testin kendisini de icerir; onu kullanmak sahte bir "telefon ulasti" uretirdi.
    $reached = @($F.reachedVia)
    if ($reached.Count -gt 0) {
      $qrUlasti = $reached | Where-Object { $_.ip -eq $F.state.network.ip }
      if (-not $qrUlasti) {
        [void]$v.Add(@{ L='??'; T="QR kodu $($F.state.network.ip) adresini gosteriyor ama telefonlar baska adresten ulasmis."
                        F='Panelden, telefonlarin gercekten ulastigi adresi secin.' })
      }
    }
  }

  # Her sey temizse: geriye kalani SOYLEMEK, "sebep bulunamadi" demekten iyidir.
  $engel = $v | Where-Object { $_.L -eq '!!' }
  $hicUlasan = $true
  if ($F.state) { $hicUlasan = (@($F.reachedVia).Count -eq 0) }
  if (-not $engel -and $hicUlasan) {
    [void]$v.Add(@{ L='??'; T='Sunucu tarafinda bir sorun bulunamadi ama hicbir telefon hic ulasmamis.'
                    F=@'
Geriye su uc olasilik kaliyor:
      1) Telefonlar baska bir Wi-Fi agina bagli (iki router varsa en olasi bu)
      2) Misafir agi kullaniliyor - misafir aglari yerel cihazlara erisimi keser
      3) Router'da "istemci izolasyonu / AP isolation" acik - ayni agdaki cihazlar
         birbirini goremez. Router arayuzunde bu ayari kapatin.
'@ })
  }

  if ($v.Count -eq 0) {
    [void]$v.Add(@{ L='OK'; T='Kontrol edilen her sey normal gorunuyor.'; F='' })
  }
  return $v
}

# Bir IPv4 adresinin ag tabani. Komsu cihazlarin istasyonla AYNI agda olup olmadigini
# karsilastirmak icin. Bayt bayt maskeleme - kaydirmali aritmetigin uint32 tasma
# koselerinden kacinmak icin bilerek en anlasilir bicim.
function Get-NetworkBase {
  param([string]$Ip, [int]$Prefix)
  try {
    $b = ([Net.IPAddress]::Parse($Ip)).GetAddressBytes()
    $out = @(0, 0, 0, 0)
    for ($i = 0; $i -lt 4; $i++) {
      $bits = [Math]::Max(0, [Math]::Min(8, $Prefix - ($i * 8)))
      $mask = [byte](256 - [Math]::Pow(2, 8 - $bits))
      $out[$i] = $b[$i] -band $mask
    }
    return ($out -join '.')
  } catch { return $null }
}

# ==============================================================================
#  KENDI KENDINI SINAMA  (ag-teshis.ps1 -Test)
# ==============================================================================
if ($Test) {
  $gecti = 0; $kaldi = 0
  function Iddia($ad, $beklenen, $gelen) {
    if ("$beklenen" -eq "$gelen") { "  OK   $ad"; $script:gecti++ }
    else { "  KALDI $ad  (beklenen=$beklenen gelen=$gelen)"; $script:kaldi++ }
  }

  "KURAL KAPSAMA"
  Iddia 'Public ag + Private kural -> kapsamaz'      $false (Test-RuleCoversCategory 'Private' 'Public')
  Iddia 'Public ag + Any kural -> kapsar'            $true  (Test-RuleCoversCategory 'Any' 'Public')
  Iddia 'Public ag + Public kural -> kapsar'         $true  (Test-RuleCoversCategory 'Public' 'Public')
  Iddia 'Private ag + Private kural -> kapsar'       $true  (Test-RuleCoversCategory 'Private' 'Private')
  Iddia 'Private ag + Public kural -> kapsamaz'      $false (Test-RuleCoversCategory 'Public' 'Private')
  Iddia 'Public ag + "Private, Public" -> kapsar'    $true  (Test-RuleCoversCategory 'Private, Public' 'Public')
  Iddia 'Domain ag + Domain kural -> kapsar'         $true  (Test-RuleCoversCategory 'Domain' 'DomainAuthenticated')
  Iddia 'Domain ag + Private kural -> kapsamaz'      $false (Test-RuleCoversCategory 'Private' 'DomainAuthenticated')
  Iddia 'kategori bos -> kapsamaz'                   $false (Test-RuleCoversCategory 'Any' '')

  "AG TABANI"
  Iddia '192.168.1.14/24 -> 192.168.1.0'  '192.168.1.0'  (Get-NetworkBase '192.168.1.14' 24)
  Iddia '10.0.5.7/16 -> 10.0.0.0'         '10.0.0.0'     (Get-NetworkBase '10.0.5.7' 16)
  Iddia '172.16.9.3/8 -> 172.0.0.0'       '172.0.0.0'    (Get-NetworkBase '172.16.9.3' 8)
  Iddia '192.168.1.14/25 -> 192.168.1.0'  '192.168.1.0'  (Get-NetworkBase '192.168.1.14' 25)
  Iddia '192.168.1.200/25 -> 192.168.1.128' '192.168.1.128' (Get-NetworkBase '192.168.1.200' 25)

  "HUKUM MOTORU"
  $temel = @{ admin=$true; appRunning=$true; listenerPids=@(1); port=8090; loopbackOk=$true
              lanOk=@('192.168.1.14'); lanIps=@('192.168.1.14'); apipaOnly=$false
              rules=@(@{}); profiles=@(); uncovered=@(); defaultRoutes=@(@{}); thirdPartyFw=@()
              neighborsOnSubnet=3; state=$null; reachedVia=@() }

  # @(...) sart: PowerShell tek elemanli koleksiyonu acar ve geriye kalan hashtable'in
  # .Count'u ANAHTAR sayisini verir (burada 3). Bu tuzagi bu test yakaladi; ayni sebeple
  # asagida Get-Verdicts'in sonucu da @(...) ile sarilir.
  $f = $temel.Clone(); $f.appRunning = $false
  Iddia 'program kapali -> tek ve ilk hukum'  1 @(Get-Verdicts $f).Count

  $f = $temel.Clone(); $f.listenerPids = @(1, 2)
  Iddia 'iki kopya -> engel bildirilir'  $true (((Get-Verdicts $f) | Where-Object { $_.T -match 'AYRI program' }).Count -gt 0)

  $f = $temel.Clone(); $f.rules = @()
  Iddia 'kural yok -> engel bildirilir'  $true (((Get-Verdicts $f) | Where-Object { $_.T -match 'ACIK bir izin yok' }).Count -gt 0)

  $f = $temel.Clone(); $f.uncovered = @(@{ Name='Kafe'; NetworkCategory='Public' })
  Iddia 'kapsamayan profil -> engel bildirilir'  $true (((Get-Verdicts $f) | Where-Object { $_.T -match 'KAPSAMIYOR' }).Count -gt 0)

  $f = $temel.Clone(); $f.lanOk = @()
  Iddia 'yalnizca loopback -> engel bildirilir'  $true (((Get-Verdicts $f) | Where-Object { $_.T -match 'yalnizca kendi icinde' }).Count -gt 0)

  $f = $temel.Clone(); $f.neighborsOnSubnet = 0
  Iddia 'agda cihaz yok -> suphe bildirilir'  $true (((Get-Verdicts $f) | Where-Object { $_.T -match 'baska hicbir cihaz' }).Count -gt 0)

  $f = $temel.Clone(); $f.defaultRoutes = @(@{InterfaceAlias='A';NextHop='1'}, @{InterfaceAlias='B';NextHop='2'})
  Iddia 'iki varsayilan rota -> suphe bildirilir'  $true (((Get-Verdicts $f) | Where-Object { $_.T -match 'birden fazla aga' }).Count -gt 0)

  # Her sey temiz ve hicbir telefon ulasmamis: geriye kalani soylemeli.
  $f = $temel.Clone()
  Iddia 'temiz + ulasan yok -> router/izolasyon olasiligi'  $true (((Get-Verdicts $f) | Where-Object { $_.T -match 'hic ulasmamis' }).Count -gt 0)

  # Hukum, uygulamanin SU ANKI reachedVia'sina degil, betigin kendi testinden once alinan
  # listeye bakmali. Aksi halde betigin kendi LAN testi "telefon ulasti" sayilir ve rapor
  # kendi kendini dogrular. Bu tuzagi calisirken fark ettim; test onu geri gelmekten korur.
  $f = $temel.Clone()
  $f.reachedVia = @()
  $f.state = @{ network = @{ reachedVia = @(@{ ip = '192.168.1.14' }); ip = '192.168.1.14'; preferredMissing = $false } }
  Iddia 'betigin kendi testi "telefon ulasti" sayilmaz'  $true (((Get-Verdicts $f) | Where-Object { $_.T -match 'hic ulasmamis' }).Count -gt 0)

  ''
  "SONUC: $gecti gecti, $kaldi kaldi"
  if ($kaldi -gt 0) { exit 1 }
  exit 0
}

# ==============================================================================
#  RAPOR TAMPONU
#  Her sey hem ekrana hem dosyaya. Ozet en sona konur ki is bitince ekranda kalan o olsun.
# ==============================================================================
$script:satirlar = New-Object Collections.ArrayList
function Yaz {
  param([string]$Metin = '')
  foreach ($s in ($Metin -split "`r?`n")) {
    [void]$script:satirlar.Add($s)
    Write-Host $s
  }
}
$sep = '=' * 70
function Baslik { param([string]$T) Yaz ''; Yaz $sep; Yaz " $T"; Yaz $sep }
function Tablo { param($Nesne) if ($Nesne) { Yaz (($Nesne | Format-Table -AutoSize | Out-String).TrimEnd()) } else { Yaz '  (kayit yok)' } }

$yonetici = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$etkilesimli = [Environment]::UserInteractive

Yaz ''
Yaz "ROVLI RADYO - AG TESHIS RAPORU"
Yaz "Tarih      : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Yaz "Bilgisayar : $env:COMPUTERNAME  (kullanici: $env:USERNAME)"
$os = Get-CimInstance Win32_OperatingSystem
Yaz "Windows    : $($os.Caption) build $($os.BuildNumber)"
Yaz "Son acilis : $($os.LastBootUpTime)"
Yaz "PowerShell : $($PSVersionTable.PSVersion)"
if ($yonetici) { Yaz "Yetki      : YONETICI (bulunan sorunlar onayinizla duzeltilebilir)" }
else { Yaz "Yetki      : normal kullanici (teshis eksiksiz, ama DUZELTME yapilamaz)" }

# Uygulamaya EN BASTA bir kez sorulur, iki sebeple:
#   1. Port her zaman 8090 degil - PORT degiskeni degistirebilir. Varsaymak yerine sor.
#   2. `reachedVia` - yani telefonlarin gercekten ulastigi adresler - bu betigin kendi
#      erisim testinden ONCE alinmali. Test, LAN adresine baglanarak uygulamada "bir telefon
#      ulasti" kaydi olusturuyor; sonradan okunsa rapor kendi kendini dogrular ve gercek bir
#      telefon baglanmis gibi gorunurdu. Olcum, olctugu seyi degistirmemeli.
$port = 8090; $httpsPort = 8443
$oncekiDurum = $null
try { $oncekiDurum = Invoke-RestMethod "http://127.0.0.1:8090/api/state" -TimeoutSec 3 } catch { }
if ($oncekiDurum -and $oncekiDurum.network.port) { $port = [int]$oncekiDurum.network.port }
if ($oncekiDurum -and $oncekiDurum.network.httpsPort) { $httpsPort = [int]$oncekiDurum.network.httpsPort }
$ulasanlar = @()
if ($oncekiDurum) { $ulasanlar = @($oncekiDurum.network.reachedVia) }

# ------------------------------------------------------------------ 1) adaptorler
Baslik "1) AG ADAPTORLERI"
Yaz "Durumu 'Up' olmayan bir adaptorun adresi de calismaz."
Tablo (Get-NetAdapter | Sort-Object Status, Name |
  Select-Object @{n='Ad';e={$_.Name}}, @{n='Durum';e={$_.Status}}, @{n='Hiz';e={$_.LinkSpeed}},
                @{n='MAC';e={$_.MacAddress}}, @{n='Donanim';e={$_.InterfaceDescription}})

# ------------------------------------------------------------------ 2) IP yapilandirmasi
Baslik "2) IP YAPILANDIRMASI"
Yaz "Telefonlar bu adreslerden BIRINE ulasabilmeli."
$ipList = Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' }
Tablo ($ipList | Select-Object @{n='Adres';e={$_.IPAddress}}, @{n='Maske';e={"/$($_.PrefixLength)"}},
                               @{n='Baglanti';e={$_.InterfaceAlias}},
                               @{n='Kaynak';e={if($_.PrefixOrigin -eq 'Dhcp'){'DHCP'}else{"$($_.PrefixOrigin)"}}})
Yaz ''
Yaz "Ag gecidi ve DNS:"
Tablo (Get-NetIPConfiguration | Select-Object @{n='Baglanti';e={$_.InterfaceAlias}},
        @{n='IPv4';e={$_.IPv4Address.IPAddress}},
        @{n='Ag gecidi';e={$_.IPv4DefaultGateway.NextHop}},
        @{n='DNS';e={(($_.DNSServer | Where-Object { $_.AddressFamily -eq 2 }).ServerAddresses) -join ', '}})
Yaz "NOT: 169.254.x.x bir adres DEGILDIR - o baglanti agdan IP alamamis demektir."

$lanIps = @($ipList | Where-Object { $_.IPAddress -notlike '169.254.*' } | Select-Object -ExpandProperty IPAddress)
$apipaOnly = ($lanIps.Count -eq 0 -and (@($ipList).Count -gt 0))

# ------------------------------------------------------------------ 3) rotalar
Baslik "3) VARSAYILAN ROTALAR"
Yaz "Birden fazlaysa bilgisayar iki aga birden bagli demektir - telefon hangisinde?"
$rotalar = @(Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort-Object InterfaceMetric)
Tablo ($rotalar | Select-Object @{n='Baglanti';e={$_.InterfaceAlias}}, @{n='Ag gecidi';e={$_.NextHop}},
                                @{n='Oncelik';e={$_.InterfaceMetric}})
if ($rotalar.Count -gt 1) { Yaz "!! $($rotalar.Count) varsayilan rota var." }

# ------------------------------------------------------------------ 4) Wi-Fi
Baslik "4) WI-FI DURUMU"
$wlan = (netsh wlan show interfaces) 2>&1 | Out-String
if ($wlan -match 'disconnected|Baglanti kesildi' -and $wlan -notmatch 'SSID') {
  Yaz "Wi-Fi bagli degil (bilgisayar kabloya bagli olabilir - sorun degil)."
} elseif ($wlan -match 'not running|bulunamadi|No wireless') {
  Yaz "Bu bilgisayarda kullanilabilir Wi-Fi arayuzu yok."
} else {
  Yaz ($wlan.TrimEnd())
}

# ------------------------------------------------------------------ 5) sanal/VPN
Baslik "5) SANAL VE VPN ADAPTORLERI"
Yaz "Bunlar bazen yayini yanlis aga yonlendirir ya da adres listesini kirletir."
$sanal = @(Get-NetAdapter | Where-Object {
  $_.InterfaceDescription -match 'Hyper-V|VMware|VirtualBox|TAP|WireGuard|OpenVPN|WSL|Tailscale|ZeroTier|Npcap|Loopback|Radmin|Hamachi' })
if ($sanal.Count -eq 0) { Yaz "  Yok - temiz." }
else { Tablo ($sanal | Select-Object @{n='Ad';e={$_.Name}}, @{n='Durum';e={$_.Status}}, @{n='Donanim';e={$_.InterfaceDescription}}) }

# ------------------------------------------------------------------ 6) ag profilleri
Baslik "6) AG PROFILLERI"
Yaz "'Public' bir agda Windows gelen baglantilari daha cok kisitlar."
$profiller = @(Get-NetConnectionProfile | Where-Object { $_.IPv4Connectivity -ne 'Disconnected' })
Tablo ($profiller | Select-Object @{n='Ag';e={$_.Name}}, @{n='Baglanti';e={$_.InterfaceAlias}},
                                  @{n='Tur';e={$_.NetworkCategory}})

# ------------------------------------------------------------------ 7) guvenlik duvari
Baslik "7) WINDOWS GUVENLIK DUVARI"
Tablo (Get-NetFirewallProfile | Select-Object @{n='Profil';e={$_.Name}}, @{n='Acik';e={$_.Enabled}},
                                              @{n='Gelen varsayilan';e={$_.DefaultInboundAction}})
Yaz ''
Yaz "Rovli Radyo kurallari (kurulum bunlari ekler):"
$tumKurallar = @(Get-NetFirewallRule -Direction Inbound | Where-Object { $_.DisplayName -match 'Rovli|Cafe Radio' })
if ($tumKurallar.Count -eq 0) { Yaz "  !! HIC KURAL YOK." }
else {
  Tablo ($tumKurallar | Select-Object @{n='Kural';e={$_.DisplayName}}, @{n='Acik';e={$_.Enabled}},
                                      @{n='Islem';e={$_.Action}}, @{n='Profil';e={$_.Profile}})
}
# Yalnizca gercekten iceri alan kurallar sayilir: kapali bir kural da, Block bir kural da
# kimseyi iceri almaz ve ikisini kapsama saymak "her sey yolunda" diyen kendinden emin bir
# yanlis uretir.
$kurallar = @($tumKurallar | Where-Object { "$($_.Enabled)" -eq 'True' -and "$($_.Action)" -eq 'Allow' })

Baslik "7b) KURAL BU AGI KAPSIYOR MU?"
Yaz "Iki bilgi ayri ayri ise yaramaz: 'kural var' ile 'ag Public' ancak birlestirilince"
Yaz "anlam kazanir. Private'a bagli bir kural, Public sayilan bir agda hicbir sey yapmaz."
$kapsanmayan = New-Object Collections.ArrayList
if ($kurallar.Count -eq 0) {
  Yaz "  Acik bir izin kurali olmadigi icin bu bolumun anlami yok."
  foreach ($p in $profiller) { [void]$kapsanmayan.Add($p) }
} elseif ($profiller.Count -eq 0) {
  Yaz "  Aktif ag profili bulunamadi."
} else {
  foreach ($p in $profiller) {
    $kat = "$($p.NetworkCategory)"
    # 'Any' kapsamli olani once goster: eski kurulumlardan kalmis tek profilli bir kural da
    # kapsayabilir, ama raporda kurulumun kendi kuralini gormek daha bilgilendirici.
    $kapsayan = $kurallar | Where-Object { Test-RuleCoversCategory "$($_.Profile)" $kat } |
                Sort-Object @{ Expression = { if ("$($_.Profile)" -eq 'Any') { 0 } else { 1 } } } | Select-Object -First 1
    if ($kapsayan) { Yaz "  OK  '$($p.Name)' ($kat) <- $($kapsayan.DisplayName)" }
    else { Yaz "  !!  '$($p.Name)' ($kat) -> BU AGI KAPSAYAN ACIK KURAL YOK"; [void]$kapsanmayan.Add($p) }
  }
}

# ------------------------------------------------------------------ 8) ucuncu parti
Baslik "8) UCUNCU PARTI GUVENLIK YAZILIMI"
Yaz "Bu programlar Windows kuralini es gecip yerel agi kendi basina kapatabilir."
$ucuncu = New-Object Collections.ArrayList
foreach ($sinif in @('AntiVirusProduct', 'FirewallProduct')) {
  try {
    $urunler = Get-CimInstance -Namespace root/SecurityCenter2 -ClassName $sinif -ErrorAction Stop
    foreach ($u in $urunler) {
      Yaz "  [$sinif] $($u.displayName)"
      if ($u.displayName -notmatch 'Windows Defender|Microsoft Defender') { [void]$ucuncu.Add($u.displayName) }
    }
  } catch { Yaz "  ($sinif okunamadi - yonetici hakki gerekebilir)" }
}
if ($ucuncu.Count -eq 0) { Yaz "  Windows disinda bir guvenlik yazilimi gorunmuyor." }

# ------------------------------------------------------------------ 9) surecler
Baslik "9) CALISAN SURECLER"
# Adiyla degil, YOLUYLA eslestir. Duz bir 'node' filtresi makinedeki her Node programini
# toplar - bu makinede test ederken alakasiz sekiz surec listelendi. ffmpeg istisna: kafe
# bilgisayarinda o zaten bize ait.
$surecler = @(Get-Process | Where-Object {
  $_.ProcessName -match 'Rovli|ffmpeg' -or
  ($_.ProcessName -match 'node|electron' -and "$($_.Path)" -match 'Rovli') })
if ($surecler.Count -eq 0) { Yaz "  Rovli ile ilgili calisan bir surec yok." }
else {
  Tablo ($surecler | Sort-Object ProcessName | Select-Object @{n='PID';e={$_.Id}}, @{n='Ad';e={$_.ProcessName}},
                                  @{n='Baslangic';e={$_.StartTime}}, @{n='Bellek MB';e={[int]($_.WorkingSet64/1MB)}})
}

# ------------------------------------------------------------------ 10) portlar
Baslik "10) PORTLARI KIM DINLIYOR"
$dinleyenPidler = @()
foreach ($p in @($port, $httpsPort)) {
  $d = @(Get-NetTCPConnection -LocalPort $p -State Listen)
  if ($d.Count -eq 0) { Yaz "  Port $p : DINLENMIYOR" ; continue }
  $pidler = @($d | Select-Object -ExpandProperty OwningProcess -Unique)
  $adlar = ($pidler | ForEach-Object { $pr = Get-Process -Id $_; if ($pr) { "$($pr.ProcessName)($_)" } else { "PID $_" } }) -join ', '
  $adresler = ($d | Select-Object -ExpandProperty LocalAddress -Unique) -join ', '
  Yaz "  Port $p : dinleniyor [$adresler] <- $adlar"
  if ($p -eq $port) { $dinleyenPidler = $pidler }
}
Yaz "  ('0.0.0.0' ya da '::' = tum aglardan kabul ediyor, dogrusu budur.)"
if ($dinleyenPidler.Count -gt 1) {
  Yaz "  !! Bu portu $($dinleyenPidler.Count) AYRI program dinliyor - iki kopya birden calisiyor olabilir."
}
$appRunning = ($dinleyenPidler.Count -gt 0)

# ------------------------------------------------------------------ 11) erisim testi
Baslik "11) ISTASYON HANGI ADRESLERDE CEVAP VERIYOR"
Yaz "DIKKAT: Windows, bilgisayarin KENDI adresine yaptigi baglantiyi guvenlik duvarindan"
Yaz "gecirmez. Bu test 'istasyon bu arayuzde dinliyor ve cevap veriyor' der; 'telefon"
Yaz "baglanabilir' DEMEZ. Degeri, sunucu arizalarini ag sorunlarindan ayirmasinda."

function Test-TcpPort {
  param([string]$Ip, [int]$Port, [int]$TimeoutMs = 1200)
  $c = New-Object Net.Sockets.TcpClient
  try {
    $iar = $c.BeginConnect($Ip, $Port, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) { return $false }
    $c.EndConnect($iar)   # reddedilen baglanti burada hata firlatir
    return $true
  } catch { return $false } finally { $c.Close() }
}

$lanOk = New-Object Collections.ArrayList
$loopbackOk = $false
foreach ($ip in (@('127.0.0.1') + $lanIps)) {
  $tcp = Test-TcpPort $ip $port
  $http = $false
  if ($tcp) {
    try { $r = Invoke-RestMethod ("http://{0}:{1}/api/state" -f $ip, $port) -TimeoutSec 4; $http = [bool]$r } catch { }
  }
  # HTTPS icin yalnizca TCP: sertifika bu bilgisayara ozel ve kendinden imzali, PowerShell
  # 5.1 onu dogrulayamaz - basarisiz bir TLS el sikismasi burada arizayi degil, beklenen
  # durumu gosterirdi.
  $tls = Test-TcpPort $ip $httpsPort
  $durum = if ($http) { 'CEVAP VERIYOR' } elseif ($tcp) { 'port acik ama HTTP cevabi yok' } else { 'ULASILAMIYOR' }
  Yaz ("  http://{0}:{1}  ->  {2}   (https portu: {3})" -f $ip, $port, $durum, $(if ($tls) { 'acik' } else { 'kapali' }))
  if ($http) { if ($ip -eq '127.0.0.1') { $loopbackOk = $true } else { [void]$lanOk.Add($ip) } }
}

# ------------------------------------------------------------------ 12) uygulamanin gordugu
Baslik "12) UYGULAMANIN KENDI GORDUGU DURUM"
$state = $null
try { $state = Invoke-RestMethod "http://127.0.0.1:$port/api/state" -TimeoutSec 5 } catch { }
if (-not $state) {
  Yaz "  !! Uygulamaya baglanilamadi (http://127.0.0.1:$port). Acik oldugundan emin olun."
} else {
  $net = $state.network
  Yaz "QR kodun gosterdigi adres : $($net.ip):$($net.port)"
  if ($net.preferredIp) { Yaz "Panelden secili adres     : $($net.preferredIp)" }
  else { Yaz "Panelden secili adres     : (secilmemis - otomatik)" }
  if ($net.preferredMissing) { Yaz "!! Secili adres bu bilgisayarda ARTIK YOK." }
  Yaz "Uygulamanin gordugu adresler:"
  foreach ($a in $net.ips) { Yaz "   - $($a.ip)  ($($a.name))" }
  Yaz ''
  # $ulasanlar, betigin kendi erisim testinden ONCE alindi - bkz. dosyanin basi. $net.reachedVia
  # su an bu betigi de icerir ve gercek bir telefon gibi gorunur.
  if ($ulasanlar.Count -gt 0) {
    Yaz "TELEFONLAR SU ADRES(LER) UZERINDEN ULASTI (bu betik calismadan once):"
    foreach ($r in $ulasanlar) { Yaz "   -> $($r.ip)   (son: $($r.lastAt))" }
  } else {
    Yaz "Hicbir telefon henuz ulasamadi."
    Yaz "(Bu betigin kendi testi sayilmaz - liste testten once alindi.)"
  }
  Yaz ''
  Yaz "Yayin akiyor mu : $($state.capabilities.flowing)  ($($state.capabilities.message))"
  Yaz "Dinleyici       : $($state.listeners)"
  Yaz "Muzik / reklam  : $(@($state.music).Count) / $(@($state.ads).Count)"
  # Uygulamanin KENDI guvenlik duvari hukmu. Bu mantik iki yerde yasiyor (burada ve
  # server/firewall-check.cjs); ikisi de yazdirilirsa bir ayrisma gorunur olur.
  if ($net.firewall) {
    Yaz ''
    Yaz "Uygulamanin kendi guvenlik duvari hukmu:"
    if ($net.firewall.problem) { Yaz "   !! $($net.firewall.message)" }
    else { Yaz "   OK - engelleyen bir sey bulmadi" }
    foreach ($a in @($net.firewall.networks)) {
      Yaz ("      {0} ({1}) kapsaniyor: {2}" -f $a.name, $a.category, $a.covered)
    }
  }
  try {
    $u = Invoke-RestMethod "http://127.0.0.1:$port/api/update/status" -TimeoutSec 4
    Yaz ''
    Yaz "Program surumu  : $($u.version)"
  } catch { }
}

# ------------------------------------------------------------------ 13) uygulama gunlugu
Baslik "13) UYGULAMANIN KENDI ARIZA GUNLUGU (son 15 sistem kaydi)"
if (-not $state) { Yaz "  (uygulama okunamadi)" }
else {
  $olaylar = @($state.history | Where-Object { $_.type -eq 'system' } | Select-Object -First 15)
  if ($olaylar.Count -eq 0) { Yaz "  Kayda deger bir olay yok." }
  else { foreach ($o in $olaylar) { Yaz ("  {0}  {1}" -f $o.at, $o.title) } }
}

# ------------------------------------------------------------------ 14) agdaki cihazlar
Baslik "14) AGDA GORUNEN CIHAZLAR"
Yaz "Telefonlarin istasyonla AYNI agda olup olmadiginin dogrudan kaniti."
$komsular = @(Get-NetNeighbor -AddressFamily IPv4 |
  Where-Object { $_.State -in 'Reachable','Stale' -and $_.IPAddress -notlike '224.*' -and
                 $_.IPAddress -notlike '239.*' -and $_.IPAddress -ne '255.255.255.255' -and
                 $_.LinkLayerAddress -and $_.LinkLayerAddress -ne '00-00-00-00-00-00' })
Tablo ($komsular | Sort-Object IPAddress | Select-Object @{n='Adres';e={$_.IPAddress}},
        @{n='MAC';e={$_.LinkLayerAddress}}, @{n='Durum';e={$_.State}}, @{n='Baglanti';e={$_.InterfaceAlias}})

# Istasyonun yayin yaptigi adresin agindaki cihaz sayisi. Ag gecidi (router) sayilmaz -
# o her zaman oradadir ve "agda kimse yok" gercegini gizler.
$komsuSayisi = 0
$yayinIp = $null
if ($state) { $yayinIp = $state.network.ip } elseif ($lanIps.Count -gt 0) { $yayinIp = $lanIps[0] }
if ($yayinIp) {
  $kendi = $ipList | Where-Object { $_.IPAddress -eq $yayinIp } | Select-Object -First 1
  if ($kendi) {
    $taban = Get-NetworkBase $yayinIp $kendi.PrefixLength
    $gecitler = @($rotalar | Select-Object -ExpandProperty NextHop -Unique)
    $ayniAg = @($komsular | Where-Object {
      (Get-NetworkBase $_.IPAddress $kendi.PrefixLength) -eq $taban -and $gecitler -notcontains $_.IPAddress })
    $komsuSayisi = $ayniAg.Count
    Yaz ''
    Yaz ("Istasyonun agi ({0}/{1}) icinde router disinda {2} cihaz goruluyor." -f $taban, $kendi.PrefixLength, $komsuSayisi)
    if ($komsuSayisi -eq 0) { Yaz "!! Bu agda baska cihaz yok - telefonlar buyuk olasilikla BASKA bir agda." }
  }
}

# ------------------------------------------------------------------ 15) proxy / hosts
Baslik "15) PROXY VE HOSTS"
Yaz ((netsh winhttp show proxy) 2>&1 | Out-String).TrimEnd()
$hosts = "$env:WINDIR\System32\drivers\etc\hosts"
$hostSatir = @(Get-Content $hosts | Where-Object { $_ -notmatch '^\s*#' -and $_.Trim() -ne '' })
if ($hostSatir.Count -eq 0) { Yaz ''; Yaz "hosts dosyasi bos (normal)." }
else { Yaz ''; Yaz "hosts dosyasindaki kayitlar:"; foreach ($h in $hostSatir) { Yaz "  $h" } }

# ==============================================================================
#  HUKUM
# ==============================================================================
$olgular = @{
  admin = $yonetici; appRunning = $appRunning; listenerPids = $dinleyenPidler
  port = $port; httpsPort = $httpsPort
  loopbackOk = $loopbackOk; lanOk = @($lanOk); lanIps = $lanIps; apipaOnly = $apipaOnly
  rules = $kurallar; profiles = $profiller; uncovered = @($kapsanmayan)
  defaultRoutes = $rotalar; thirdPartyFw = @($ucuncu)
  neighborsOnSubnet = $komsuSayisi; state = $state; reachedVia = $ulasanlar
}
$hukumler = @(Get-Verdicts $olgular)   # @(): tek hukumde koleksiyon acilmasin

Yaz ''
Yaz ('#' * 70)
Yaz " OZET - MUHTEMEL SEBEP"
Yaz ('#' * 70)
$sira = 0
foreach ($h in $hukumler) {
  $sira++
  Yaz ''
  Yaz ("[{0}] {1}. {2}" -f $h.L, $sira, $h.T)
  if ($h.F) { foreach ($fs in ($h.F -split "`r?`n")) { Yaz "     $fs" } }
}

# ==============================================================================
#  ONAYLI DUZELTMELER
#  Varsayilan HAYIR: Enter'a basmak hicbir seyi degistirmez.
# ==============================================================================
$yapilanlar = New-Object Collections.ArrayList
$teklifler = @($hukumler | Where-Object { $_.Fix })

if ($teklifler.Count -gt 0) {
  Yaz ''
  Yaz ('#' * 70)
  Yaz " DUZELTME"
  Yaz ('#' * 70)

  if (-not $yonetici) {
    Yaz "Bu sorunlar duzeltilebilir ama YONETICI hakki gerekiyor."
    Yaz "PowerShell'i sag tiklayip 'Yonetici olarak calistir' ile acip ayni komutu tekrarlayin."
  } elseif (-not $etkilesimli) {
    Yaz "Etkilesimli olmayan bir oturumda calisiyor - hicbir sey degistirilmedi."
  } else {
    function Sor { param([string]$Soru)
      Write-Host ''
      try { $c = Read-Host "$Soru [e/H]" } catch { return $false }   # okunamiyorsa HAYIR
      return ($c -match '^(e|E|y|Y)')
    }
    function Uygula { param([string]$Aciklama, [scriptblock]$Is, [string]$Komut)
      Write-Host "  Calisacak komut: $Komut"
      try { & $Is; Yaz "YAPILDI: $Komut"; [void]$script:yapilanlar.Add($Komut); return $true }
      catch { Yaz "BASARISIZ: $Komut  --> $($_.Exception.Message)"; return $false }
    }

    foreach ($t in $teklifler) {
      switch ($t.Fix) {

        'kural-ekle' {
          Yaz ''
          Yaz "TEKLIF: Guvenlik duvari kurallarini kurulumun yazdigi bicimde olustur."
          Yaz "        (uc kural, tum ag profilleri icin - kurulumun yaptiginin aynisi)"
          if (Sor "Kurallar eklensin mi?") {
            $exe = $null
            $pr = Get-Process | Where-Object { $_.ProcessName -match 'Rovli' } | Select-Object -First 1
            if ($pr) { $exe = $pr.Path }
            if ($exe) {
              Uygula 'program izni' { New-NetFirewallRule -DisplayName 'Rovli Radyo' -Direction Inbound -Action Allow -Program $exe -Profile Any -Enabled True | Out-Null } "New-NetFirewallRule -DisplayName 'Rovli Radyo' -Program '$exe' -Profile Any"
            } else {
              Yaz "  (calisan program bulunamadi - yalnizca port kurallari eklenecek)"
            }
            Uygula 'http portu' { New-NetFirewallRule -DisplayName "Rovli Radyo HTTP $port" -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port -Profile Any -Enabled True | Out-Null } "New-NetFirewallRule -DisplayName 'Rovli Radyo HTTP $port' -Protocol TCP -LocalPort $port -Profile Any"
            Uygula 'https portu' { New-NetFirewallRule -DisplayName "Rovli Radyo HTTPS $httpsPort" -Direction Inbound -Action Allow -Protocol TCP -LocalPort $httpsPort -Profile Any -Enabled True | Out-Null } "New-NetFirewallRule -DisplayName 'Rovli Radyo HTTPS $httpsPort' -Protocol TCP -LocalPort $httpsPort -Profile Any"
          } else { Yaz "  (atlandi)" }
        }

        'kural-genislet' {
          Yaz ''
          Yaz "TEKLIF: Iki cozumden birini secin."
          # Teklifler, hukmu ureten veriden AYRI okunuyor. Ikisi ayrisirsa "hicbir sey
          # yapmayacak" bir secenek sunulur - kullaniciya evet dedirtip hicbir sey yapmamak,
          # hic sormamaktan kotudur. Bu yuzden her secenek once uygulanabilir mi diye bakilir.
          if ($kurallar.Count -eq 0 -and $kapsanmayan.Count -eq 0) {
            Yaz "  (uygulanabilir bir secenek kalmadi - durum bu arada degismis olabilir)"
            break
          }
          if ($kurallar.Count -gt 0) { Yaz "  A) Mevcut kurallari TUM ag profillerine ac (onerilen - kurulumun yaptigi budur)" }
          if ($kapsanmayan.Count -gt 0) { Yaz "  B) Su agi 'Ozel' (Private) yap: $(($kapsanmayan | ForEach-Object { $_.Name }) -join ', ')" }
          if ($kurallar.Count -gt 0 -and (Sor "A - kurallar tum profillere acilsin mi?")) {
            foreach ($k in $kurallar) {
              Uygula 'kural genislet' { Set-NetFirewallRule -DisplayName $k.DisplayName -Profile Any } "Set-NetFirewallRule -DisplayName '$($k.DisplayName)' -Profile Any"
            }
          } elseif ($kapsanmayan.Count -gt 0 -and (Sor "B - ag 'Ozel' yapilsin mi?")) {
            foreach ($p in $kapsanmayan) {
              Uygula 'ag ozel' { Set-NetConnectionProfile -InterfaceIndex $p.InterfaceIndex -NetworkCategory Private } "Set-NetConnectionProfile -InterfaceIndex $($p.InterfaceIndex) -NetworkCategory Private"
            }
          } else { Yaz "  (atlandi)" }
        }

        'kopya' {
          Yaz ''
          Yaz "TEKLIF: Fazla kopyalari kapat."
          $enEski = $null
          foreach ($pid in $dinleyenPidler) {
            $pr = Get-Process -Id $pid
            if ($pr -and (-not $enEski -or $pr.StartTime -lt $enEski.StartTime)) { $enEski = $pr }
          }
          if (-not $enEski) { Yaz "  (surecler okunamadi, atlandi)" ; break }
          Yaz "  Acik kalacak (en once baslayan): $($enEski.ProcessName) PID $($enEski.Id)"
          foreach ($pid in $dinleyenPidler) {
            if ($pid -eq $enEski.Id) { continue }
            $pr = Get-Process -Id $pid
            $ad = if ($pr) { $pr.ProcessName } else { '?' }
            if (Sor "PID $pid ($ad) kapatilsin mi?") {
              Uygula 'kopya kapat' { Stop-Process -Id $pid -Force } "Stop-Process -Id $pid -Force"
            } else { Yaz "  (PID $pid atlandi)" }
          }
        }
      }
    }

    if ($yapilanlar.Count -gt 0) {
      Yaz ''
      Yaz "Degisiklikten sonraki durum:"
      $yeniKurallar = @(Get-NetFirewallRule -Direction Inbound | Where-Object { $_.DisplayName -match 'Rovli|Cafe Radio' } |
        Where-Object { "$($_.Enabled)" -eq 'True' -and "$($_.Action)" -eq 'Allow' })
      foreach ($p in @(Get-NetConnectionProfile | Where-Object { $_.IPv4Connectivity -ne 'Disconnected' })) {
        $kat = "$($p.NetworkCategory)"
        $var = $yeniKurallar | Where-Object { Test-RuleCoversCategory "$($_.Profile)" $kat } | Select-Object -First 1
        if ($var) { Yaz "  OK  '$($p.Name)' ($kat) <- $($var.DisplayName)" }
        else { Yaz "  !!  '$($p.Name)' ($kat) hala kapsanmiyor" }
      }
      Yaz ''
      Yaz "Simdi telefondan tekrar deneyin."
    }
  }
}

# ==============================================================================
#  RAPOR DOSYASI
# ==============================================================================
if ($yapilanlar.Count -gt 0) {
  [void]$script:satirlar.Add('')
  [void]$script:satirlar.Add('YAPILAN DEGISIKLIKLER:')
  foreach ($y in $yapilanlar) { [void]$script:satirlar.Add("  $y") }
}

$dosyaAdi = "rovli-ag-raporu-$(Get-Date -Format 'yyyyMMdd-HHmm').txt"
$hedef = Join-Path ([Environment]::GetFolderPath('Desktop')) $dosyaAdi
try { $script:satirlar | Out-File -FilePath $hedef -Encoding utf8 -ErrorAction Stop }
catch {
  $hedef = Join-Path $env:TEMP $dosyaAdi
  try { $script:satirlar | Out-File -FilePath $hedef -Encoding utf8 -ErrorAction Stop } catch { $hedef = $null }
}

Write-Host ''
Write-Host ('#' * 70)
if ($hedef) {
  Write-Host " RAPOR KAYDEDILDI:"
  Write-Host "   $hedef"
  Write-Host " Bu dosyayi gonderin - ekrandan kopyalamaniza gerek yok."
} else {
  Write-Host " Rapor dosyasi yazilamadi. Ekrandaki ciktinin tamamini kopyalayip gonderin."
}
Write-Host ('#' * 70)
Write-Host ''

# Read-Host, stdin kapaliyken hata firlatir ve betik 255 ile biter - UserInteractive bunu
# yakalamiyor (yonlendirilmis girdide de true donuyor, olculdu). Beklemek bir kolayliktir,
# basarisiz olmasi raporu gecersiz kilmamali.
try { if ($etkilesimli) { Read-Host "Kapatmak icin Enter'a basin" | Out-Null } } catch { }
exit 0
