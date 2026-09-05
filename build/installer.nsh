; Custom NSIS steps for Rovli Radyo.
;
; Two jobs:
;   1. Open the Windows Firewall for the app + its LAN ports, so phones on the same
;      Wi-Fi can reach the station. Removed again on uninstall.
;   2. Narrate what is happening. The operator is not a developer and installs this on
;      the cafe's own PC, so the installer says in plain language which folders it
;      writes to, what it does NOT touch, and where the music library lives.
;
; All text here is deliberately plain ASCII (no Turkish accented letters). NSIS string
; encoding depends on how makensis is invoked, and a mismatch turns accented characters
; into mojibake in the very messages meant to reassure the operator.

; The firewall rule used to point at "Cafe Radio.exe" while electron-builder ships the
; binary as "Rovli Radyo.exe" (productName), so the program rule silently matched nothing.
; Kept in sync with productName in package.json.
!define APP_EXE "Rovli Radyo.exe"
!define FW_APP "Rovli Radyo"
!define FW_HTTP "Rovli Radyo HTTP 8090"
!define FW_HTTPS "Rovli Radyo HTTPS 8443"
; The data folder is named after the "name" field in package.json, NOT productName:
; Electron derives app.getPath('userData') from the app name, so it is the hyphenated
; "rovli-radyo" and not "Rovli Radyo". Verified against the live install on the cafe PC,
; which holds the real library under %APPDATA%\rovli-radyo\data. Printing the wrong path
; would send the operator hunting for a folder that does not exist.
!define DATA_DIR "%APPDATA%\rovli-radyo\data"

!macro customInstall
  SetDetailsPrint both
  SetDetailsView show

  DetailPrint ""
  DetailPrint "------------------------------------------------------------"
  DetailPrint " Rovli Radyo - kurulum ne yapiyor?"
  DetailPrint "------------------------------------------------------------"
  DetailPrint ""
  DetailPrint "[1/3] Program dosyalari kopyalandi:"
  DetailPrint "      $INSTDIR"
  DetailPrint "      Icinde: uygulama, web arayuzu ve ffmpeg ses motoru."
  DetailPrint "      (Yukaridaki listede kopyalanan her dosya tek tek gorunur.)"
  DetailPrint ""

  DetailPrint "[2/3] Windows Guvenlik Duvari kurallari ekleniyor."
  DetailPrint "      Bunlar olmadan telefonlar radyoya BAGLANAMAZ."
  DetailPrint "      Sadece yerel agdan gelen baglantiya izin verilir;"
  DetailPrint "      internete acilan bir sey yoktur."
  DetailPrint ""

  ; Older builds installed rules under the "Cafe Radio" name. Clear them first so a
  ; machine upgraded from an old version does not accumulate duplicates.
  DetailPrint "      - eski surumden kalan kurallar temizleniyor"
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Cafe Radio"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Cafe Radio HTTP 8090"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Cafe Radio HTTPS 8443"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="${FW_APP}"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="${FW_HTTP}"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="${FW_HTTPS}"'

  DetailPrint "      - programa izin: $INSTDIR\${APP_EXE}"
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="${FW_APP}" dir=in action=allow program="$INSTDIR\${APP_EXE}" enable=yes profile=any remoteip=localsubnet'
  DetailPrint "      - port 8090 (telefonlarin dinledigi adres)"
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="${FW_HTTP}" dir=in action=allow protocol=TCP localport=8090 profile=any remoteip=localsubnet'
  DetailPrint "      - port 8443 (telefondan anons icin guvenli adres)"
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="${FW_HTTPS}" dir=in action=allow protocol=TCP localport=8443 profile=any remoteip=localsubnet'
  DetailPrint ""

  DetailPrint "[3/3] Muzikleriniz ve ayarlariniz nerede tutulacak:"
  DetailPrint "      ${DATA_DIR}"
  DetailPrint "      (klasor adi kucuk harf ve tireli: rovli-radyo)"
  DetailPrint "      Icinde: Music\  Ads\  station.json  admin.json  certs\"
  DetailPrint ""
  DetailPrint "      Kurulum bu klasore DOKUNMAZ. Zaten varsa muzikleriniz"
  DetailPrint "      ve ayarlariniz oldugu gibi korunur; yoksa program ilk"
  DetailPrint "      acildiginda kendisi olusturur, yonetici kodunu uretir"
  DetailPrint "      ve bu bilgisayara ozel guvenlik sertifikasini hazirlar."
  DetailPrint ""

  DetailPrint "------------------------------------------------------------"
  DetailPrint " Kurulum bunlarin DISINDA hicbir dosya silmez, tasimaz"
  DetailPrint " veya degistirmez. Belgeleriniz, masaustunuz ve diger"
  DetailPrint " programlariniz etkilenmez."
  DetailPrint "------------------------------------------------------------"
  DetailPrint ""
!macroend

!macro customUnInstall
  SetDetailsPrint both
  SetDetailsView show

  DetailPrint ""
  DetailPrint "------------------------------------------------------------"
  DetailPrint " Rovli Radyo - kaldirma islemi ne yapiyor?"
  DetailPrint "------------------------------------------------------------"
  DetailPrint ""
  DetailPrint "[1/2] Guvenlik duvari kurallari kaldiriliyor."
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="${FW_APP}"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="${FW_HTTP}"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="${FW_HTTPS}"'
  ; Old names, in case this machine was first set up by a pre-rename build.
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Cafe Radio"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Cafe Radio HTTP 8090"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Cafe Radio HTTPS 8443"'
  DetailPrint ""

  DetailPrint "[2/2] Program dosyalari siliniyor:"
  DetailPrint "      $INSTDIR"
  DetailPrint ""

  DetailPrint "------------------------------------------------------------"
  DetailPrint " MUZIKLERINIZ VE AYARLARINIZ SILINMEDI."
  DetailPrint " Su klasorde duruyor:"
  DetailPrint "      ${DATA_DIR}"
  DetailPrint ""
  DetailPrint " Programi tekrar kurarsaniz muzikleriniz, reklamlariniz"
  DetailPrint " ve ayarlariniz oldugu gibi geri gelir."
  DetailPrint " Tamamen silmek isterseniz bu klasoru elle silin."
  DetailPrint "------------------------------------------------------------"
  DetailPrint ""
!macroend
