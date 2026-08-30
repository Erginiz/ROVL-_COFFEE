import { StrictMode, Component, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'

// Keeps a render error from white-screening the whole app; offers a reload.
class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null } }
  static getDerivedStateFromError(error) { return { error } }
  componentDidCatch(error, info) { console.error('Arayüz hatası:', error, info) }
  render() {
    if (this.state.error) {
      return <main className="loading"><div style={{ textAlign: 'center', maxWidth: 360 }}><p>Bir arayüz hatası oluştu.</p><button className="listen-button" style={{ marginTop: 14, width: 'auto', padding: '12px 22px' }} onClick={() => location.reload()}>Yeniden Yükle</button></div></main>
    }
    return this.props.children
  }
}

const api = async (url, options = {}) => {
  // Bound every request so a hung server can never freeze the UI indefinitely.
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8000)
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { 'Content-Type': 'application/json', ...adminHeaders(), ...(options.headers || {}) }, ...options })
    if (response.status === 403) dropExpiredAdmin()
    if (!response.ok) throw new Error(await response.text())
    return response.status === 204 ? null : response.json()
  } finally { clearTimeout(timeout) }
}
const fmt = seconds => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`

// Captures the admin's microphone as raw PCM (s16le mono) and streams ordered
// chunks to the server, which mixes them into the live broadcast. Raw PCM is
// headerless, so the mix keeps working across song changes without desync.
// `onDropped` is called if the announcement dies on its own (an expired session, the server
// refusing the stream) so the caller can tell the operator and reset its button, instead of
// leaving a panel that says "Anonsu Bitir" over a microphone that is going nowhere.
function createMicStreamer({ onDropped } = {}) {
  let ctx, stream, proc, mute, active = false
  let queue = []; let queuedBytes = 0; let sending = false
  // Keep at most ~0.25s of audio buffered; if the network stalls, drop the
  // OLDEST audio instead of delaying, so the announcement stays real-time.
  const MAX_QUEUE_BYTES = 24000
  const flush = async () => {
    if (sending || !active) return
    sending = true
    try {
      while (queue.length) {
        // Merge everything pending into ONE request so per-chunk round-trips
        // cannot stack up and grow the announcement delay.
        const batch = queue; queue = []; queuedBytes = 0
        let total = 0; for (const b of batch) total += b.byteLength
        const merged = new Uint8Array(total); let off = 0
        for (const b of batch) { merged.set(new Uint8Array(b), off); off += b.byteLength }
        try {
          const sent = await fetch('/api/mic/chunk', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', ...adminHeaders() }, body: merged })
          // A session that expires MID-ANNOUNCEMENT is the same silent failure as one that
          // expired before it: stop, and let the operator know rather than letting them keep
          // talking into a microphone nobody can hear.
          if (!sent.ok && (sent.status === 403 || sent.status === 409)) {
            if (sent.status === 403) dropExpiredAdmin()
            onDropped?.(sent.status === 403 ? 'Yönetici oturumu sona erdi — anons durduruldu.' : 'Anons sunucu tarafından durduruldu.')
            active = false
            return
          }
        } catch (err) { console.error('Mikrofon gönderilemedi:', err) }
      }
    } finally { sending = false }
  }
  const start = async () => {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
    ctx = new (window.AudioContext || window.webkitAudioContext)()
    const source = ctx.createMediaStreamSource(stream)
    proc = ctx.createScriptProcessor(2048, 1, 1) // smaller frame = lower capture latency
    mute = ctx.createGain(); mute.gain.value = 0 // route to destination silently so onaudioprocess fires without local feedback
    source.connect(proc); proc.connect(mute); mute.connect(ctx.destination)
    active = true
    // Announce the mic + its real sample rate BEFORE any audio flows. The result is CHECKED:
    // this call goes out with the phone's session token, and a token that expired overnight
    // is refused. Ignoring that left the worst possible outcome — the browser grants the mic,
    // the operator speaks into a live-looking panel, and not a sound reaches the café.
    const announced = await fetch('/api/control', { method: 'POST', headers: { 'Content-Type': 'application/json', ...adminHeaders() }, body: JSON.stringify({ action: 'microphoneStart', value: ctx.sampleRate }) })
    if (!announced.ok) {
      if (announced.status === 403) dropExpiredAdmin()
      await stop()
      throw new Error(announced.status === 403
        ? 'Yönetici oturumu sona ermiş. Kodu yeniden girin.'
        : 'Anons başlatılamadı')
    }
    proc.onaudioprocess = event => {
      if (!active) return
      const input = event.inputBuffer.getChannelData(0)
      const pcm = new Int16Array(input.length)
      for (let i = 0; i < input.length; i++) { const s = Math.max(-1, Math.min(1, input[i])); pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff }
      queue.push(pcm.buffer); queuedBytes += pcm.buffer.byteLength
      while (queuedBytes > MAX_QUEUE_BYTES && queue.length > 1) { queuedBytes -= queue.shift().byteLength }
      flush()
    }
  }
  const stop = async () => {
    active = false
    try { if (proc) proc.onaudioprocess = null } catch {}
    try { proc?.disconnect() } catch {}
    try { mute?.disconnect() } catch {}
    try { stream?.getTracks().forEach(track => track.stop()) } catch {}
    try { await ctx?.close() } catch {}
    queue = []; queuedBytes = 0
    try { await fetch('/api/control', { method: 'POST', headers: { 'Content-Type': 'application/json', ...adminHeaders() }, body: JSON.stringify({ action: 'microphoneStop' }) }) } catch {}
    try { await fetch('/api/mic/end', { method: 'POST', headers: { ...adminHeaders() } }) } catch {}
  }
  return { start, stop }
}
// Yönetici kodu KASITLI olarak burada tutulmuyor. Bu dosya her telefona indiriliyor, yani
// buraya yazılan her kod müşteriler tarafından okunabilir. Kod sunucuda duruyor; telefon
// kodu /api/admin/login adresine gönderiyor ve karşılığında rastgele bir oturum anahtarı
// alıyor. Sadece o anahtar telefonda saklanıyor.
async function adminLogin(code) {
  const response = await fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })
  const info = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(info.error || 'Giriş yapılamadı')
  try { localStorage.setItem('cr_admin_token', info.token) } catch {}
  return info.token
}
// Oturum anahtarının süresi dolduğunda (12 saat) sunucu 403 döner. Anahtarı atıp arayüzü
// yönetici modundan çıkarıyoruz; aksi hâlde telefon çalışmayan düğmeler göstermeye devam eder.
function dropExpiredAdmin() {
  try { if (!localStorage.getItem('cr_admin_token')) return } catch { return }
  try { localStorage.removeItem('cr_admin_token') } catch {}
  window.dispatchEvent(new Event('cr-admin-expired'))
}
function adminLogout() {
  const token = (() => { try { return localStorage.getItem('cr_admin_token') } catch { return null } })()
  try { localStorage.removeItem('cr_admin_token') } catch {}
  if (token) fetch('/api/admin/logout', { method: 'POST', headers: { 'x-admin-token': token } }).catch(() => {})
}
// Kodu sorup girişi yapan ortak akış. Başarılıysa true döner.
async function promptAdminLogin() {
  const code = window.prompt('Yönetici kodu:')
  if (code == null) return false
  try { await adminLogin(code.trim()); return true }
  catch (error) { alert(error.message || 'Giriş yapılamadı'); return false }
}
// iOS <audio>.volume'u yok sayar (yalnızca donanım tuşları), bu yüzden kişisel ses çubuğu
// iPhone/iPad'de etkisiz — o cihazlarda kullanıcıya bir not gösteriyoruz. iPadOS 13+ kendini
// Mac gibi tanıttığı için dokunma noktası sayısıyla da kontrol ediyoruz.
const IS_IOS = /iP(hone|od|ad)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
// The server lets the operator's own machine (localhost) mutate freely, but a phone on
// the café Wi-Fi must log in first. Once this device holds a session token, attach it to
// every request; the server ignores it for localhost, so it's harmless on the desk PC.
function adminHeaders() {
  try { const token = localStorage.getItem('cr_admin_token'); return token ? { 'x-admin-token': token } : {} } catch { return {} }
}

function useStation() {
  const [station, setStation] = useState(null)
  useEffect(() => {
    let events, retry, closed = false
    const connect = () => {
      api('/api/state').then(setStation).catch(() => {})
      events = new EventSource('/api/events')
      // The server leaves the music and ad lists out of a frame while they have not changed —
      // they are most of the payload and it goes out hundreds of times an hour over the café
      // Wi-Fi. Keep whatever the last frame that carried them gave us, so an omission means
      // "unchanged" rather than "now empty".
      events.onmessage = event => {
        try {
          const incoming = JSON.parse(event.data)
          setStation(previous => previous ? {
            ...previous, ...incoming,
            music: incoming.music ?? previous.music,
            ads: incoming.ads ?? previous.ads
          } : incoming)
        } catch {}
      }
      // Surface the failure and reconnect instead of silently freezing on stale data.
      events.onerror = () => {
        console.error('Canlı bağlantı koptu, yeniden bağlanılıyor…')
        try { events.close() } catch {}
        if (!closed) { clearTimeout(retry); retry = setTimeout(connect, 3000) }
      }
    }
    connect()
    return () => { closed = true; clearTimeout(retry); try { events?.close() } catch {} }
  }, [])
  return station
}

// Canlı yayında asıl gecikme sunucuda değil, tarayıcının kendi tamponunda birikiyor: her
// cihaz ne kadar önden tamponlayacağına kendi karar veriyor, bu yüzden PC ile telefon
// zamanla birbirinden ayrılıyor ve ses seviyesi değişikliği geç duyuluyor.
//
// Geride kalan cihazı %3 hızlandırarak canlı uca çekiyoruz — %3 fark kulakta duyulmaz.
// currentTime ile atlamak yerine bunu tercih ediyoruz çünkü atlamak mobil tarayıcılarda
// yeniden tamponlamaya ve sesin kesilmesine yol açıyor. Yalnızca telefon uzun süre arka
// planda kalıp birikim çok büyüdüyse (ekran kilidi) gerçekten atlıyoruz; orada %3 ile
// yetişmek dakikalar sürerdi.
const LIVE_EDGE_CATCHUP = 1.0   // sn — bunun üstünde hızlan
const LIVE_EDGE_OK = 0.5        // sn — bunun altında normale dön
const LIVE_EDGE_RESYNC = 5.0    // sn — bunun üstünde atlayarak eşitle
// What to do about a phone that has drifted behind the live edge, as a plain decision. It
// runs on every listening phone every two seconds and both of its outcomes are audible — a
// 3% speed-up is a subtly sharp café, a seek is a jump mid-song — and none of it was covered
// by anything. Separated out so the thresholds can be tested directly, the way this project
// already does for the ezan window and the login brake.
//
// Returns null when there is nothing to do, so "leave it alone" is a distinct answer rather
// than a rate that happens to equal the current one.
export function liveEdgeAction(behind, currentRate = 1) {
  if (!Number.isFinite(behind) || behind < 0) return null
  // Far behind: catching up by playing faster would take minutes and be audible the whole
  // time. Jump instead, and land slightly behind the edge rather than exactly on it — right
  // at the edge the next network hiccup underruns the buffer.
  if (behind > LIVE_EDGE_RESYNC) return { seek: true, rate: 1 }
  if (behind > LIVE_EDGE_CATCHUP) return { seek: false, rate: 1.03 }
  // Below the OK mark, always return to normal speed. Without this the phone would stay
  // slightly fast for as long as it kept drifting in and out of the middle band.
  if (behind < LIVE_EDGE_OK) return { seek: false, rate: 1 }
  // Between OK and CATCHUP: deliberately do nothing, so a phone hovering around a threshold
  // does not flip speed every two seconds.
  return { seek: false, rate: currentRate }
}

function useLiveEdge(audioRef) {
  useEffect(() => {
    const timer = setInterval(() => {
      const audio = audioRef.current
      if (!audio || audio.paused || !audio.buffered.length) return
      const edge = audio.buffered.end(audio.buffered.length - 1)
      const action = liveEdgeAction(edge - audio.currentTime, audio.playbackRate)
      if (!action) return
      try {
        if (action.seek) audio.currentTime = edge - LIVE_EDGE_OK
        if (audio.playbackRate !== action.rate) audio.playbackRate = action.rate
      } catch {}
    }, 2000)
    return () => clearInterval(timer)
  }, [audioRef])
}

function Status({ station, compact = false }) {
  const current = station.current
  return <section className={'now-playing ' + (compact ? 'compact' : '')}>
    <div className="art">♪</div><div className="track-copy"><span className="eyebrow">ŞİMDİ ÇALIYOR</span><strong>{current?.title || 'Yayın hazır'}</strong><span>{current?.artist || 'Müzik ekleyerek başlayın'}</span></div>
    {!compact && <div className={'status-pill ' + station.playback.status}>{station.playback.status === 'playing' ? 'Yayında' : 'Bekliyor'}</div>}
  </section>
}

function Progress({ station, editable = false, onSeek }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(timer) }, [])
  const duration = Number(station.current?.durationSeconds || 0)
  const started = new Date(station.playback.currentStartedAt || now).getTime()
  const position = station.playback.status === 'playing' ? Math.min(duration || Infinity, Math.max(0, (now - started) / 1000)) : Number(station.playback.currentOffsetSeconds || 0)
  return <section className="progress-card"><input className="seek-range" aria-label="Parça konumu" type="range" min="0" max={duration || 1} step="1" value={Math.min(duration || 0, position)} disabled={!editable || !duration} onChange={event => onSeek?.(Number(event.target.value))} /><div className="progress-times"><span>{fmt(position)}</span><span>{duration ? fmt(duration) : '--:--'}</span></div>{editable && duration ? <small>Yönetici: çubuğu sürükleyerek yayını sarabilirsiniz.</small> : null}</section>
}

function DropZone({ kind, label }) {
  const input = useRef()
  const upload = async files => {
    for (const file of files) {
      const body = new FormData(); body.append('file', file)
      try {
        // Not api(): this body is multipart, not JSON. The 403 handling api() does has to be
        // repeated here, or an expired session turns every upload into a silent no-op.
        const res = await fetch('/api/media/' + kind, { method: 'POST', headers: { ...adminHeaders() }, body })
        if (res.status === 403) dropExpiredAdmin()
        if (!res.ok) { const info = await res.json().catch(() => ({})); alert(`"${file.name}" yüklenemedi: ${info.error || 'HTTP ' + res.status}`) }
      } catch (err) { alert(`"${file.name}" yüklenemedi: ${err?.message || 'bağlantı hatası'}`) }
    }
  }
  return <button className="dropzone" onClick={() => input.current.click()} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); upload(event.dataTransfer.files) }}><input ref={input} type="file" accept="audio/*" multiple hidden onChange={event => upload(event.target.files)} /><b>+ {label}</b><span>Sürükleyip bırakın veya seçin</span></button>
}
function Library({ station, kind }) {
  const data = kind === 'music' ? station.music : station.ads
  const title = kind === 'music' ? 'Tüm Müzikler' : 'Tüm Reklamlar'
  return <section className="card media-card"><div className="card-title"><h2>{title}</h2><div style={{ display: 'flex', gap: 10, alignItems: 'center' }}><span>{data.length} dosya</span><button className="outline" onClick={() => api('/api/rescan', { method: 'POST' }).catch(() => {})}>Yenile</button><button className="outline" onClick={() => api('/api/open-folder/' + kind, { method: 'POST' }).catch(() => {})}>Klasörü Aç</button></div></div><div className="file-list">{data.map(item => <div className="file" key={item.id}><span className="file-dot">♪</span><span>{item.title}</span><small>{item.durationSeconds ? fmt(item.durationSeconds) : ''}</small><button onClick={() => { if (window.confirm(`Silinsin mi: ${item.title}?`)) api(`/api/media/${kind}/${item.id}`, { method: 'DELETE' }).catch(() => {}) }}>x</button></div>) || <p className="empty">Henüz dosya yok.</p>}</div><p className="muted">Dosyaları buraya sürükleyebilir ya da “Klasörü Aç” deyip doğrudan klasöre atabilirsiniz — otomatik görünür.</p><DropZone kind={kind} label={kind === 'music' ? 'Müzik Ekle' : 'Reklam Ekle'} /></section>
}

const svgIcon = (children, size = 22) => <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true">{children}</svg>
const ICONS = {
  note: svgIcon(<path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3z"/>, 28),
  noteSmall: svgIcon(<path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3z"/>, 15),
  prev: svgIcon(<path d="M7 6h2v12H7zm3.5 6 8.5 6V6z"/>),
  next: svgIcon(<path d="M15 6h2v12h-2zM5 18l8.5-6L5 6z"/>),
  play: svgIcon(<path d="M8 5v14l11-7z"/>, 26),
  pause: svgIcon(<path d="M6 5h4v14H6zm8 0h4v14h-4z"/>, 26),
  stop: svgIcon(<rect x="6" y="6" width="12" height="12" rx="2"/>),
  shuffle: svgIcon(<path d="M10.59 9.17 5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/>),
  vol: svgIcon(<path d="M3 10v4h4l5 5V5L7 10H3zm13.5 2A4.5 4.5 0 0 0 14 7.97v8.05A4.5 4.5 0 0 0 16.5 12z"/>, 20)
}

// Spotify/YouTube-Music-style player bar. The progress is driven by the monitor
// <audio>'s real currentTime (not the server clock), so the bar stays in sync
// with the sound you actually hear and does not run ahead while buffering.
function Player({ station, control, save, audioRef, monitorReady, localVol, onLocalVol }) {
  const current = station.current
  const pb = station.playback
  const status = pb.status
  const duration = Number(current?.durationSeconds || 0)
  const [, forceTick] = useState(0)
  useEffect(() => { const t = setInterval(() => forceTick(x => (x + 1) % 1e6), 250); return () => clearInterval(t) }, [])
  // Reset the audio-time baseline whenever the track or start point changes.
  const baseRef = useRef({ base: 0, offset: 0, key: '' })
  // While dragging the seek bar, follow the finger locally and commit ONE seek on
  // release — so the thumb never lags and ffmpeg isn't restarted on every pixel.
  const [dragValue, setDragValue] = useState(null)
  const commitTimer = useRef()
  // One release fires pointerup AND mouseup (and touchend on mobile) on the same range
  // input. Without this guard each release sent 2-3 identical 'seek' requests, and every
  // seek restarts the server-side decoder — so a single drag caused 2-3 decoder respawns
  // and an audible re-buffer. Send at most once per distinct value; reset on a new drag.
  const lastSentRef = useRef(null)
  const commitSeek = () => {
    if (dragValue == null) return
    const v = dragValue
    if (lastSentRef.current === v) return   // duplicate event for the same release — ignore
    lastSentRef.current = v
    control('seek', v)
    clearTimeout(commitTimer.current)
    commitTimer.current = setTimeout(() => setDragValue(cur => (cur === v ? null : cur)), 700)
  }
  const key = (pb.currentId || '') + '|' + (pb.currentStartedAt || '')
  if (baseRef.current.key !== key) {
    baseRef.current = { base: audioRef.current?.currentTime || 0, offset: Number(pb.currentOffsetSeconds || 0), key }
  }
  const el = audioRef.current
  const monitoring = !!(el && !el.paused)   // is THIS PC actually playing the stream?
  let position
  if (monitoring) {
    // Track the real audio: the bar advances only as sound is heard, so it never
    // runs ahead of the audio while the stream is still buffering.
    position = baseRef.current.offset + Math.max(0, (el.currentTime || 0) - baseRef.current.base)
  } else if (status === 'playing') {
    // Broadcast is live but this PC isn't monitoring — show the server position.
    const started = pb.currentStartedAt ? new Date(pb.currentStartedAt).getTime() : 0
    position = started ? Math.max(0, (Date.now() - started) / 1000) : Number(pb.currentOffsetSeconds || 0)
  } else {
    position = Number(pb.currentOffsetSeconds || 0)
  }
  position = Math.max(0, duration ? Math.min(duration, position) : position)
  const buffering = status === 'playing' && monitoring && !monitorReady
  const isPlaying = status === 'playing'
  const shownVal = dragValue != null ? dragValue : Math.min(duration || 0, position)
  const pct = duration ? Math.min(100, Math.max(0, (shownVal / duration) * 100)) : 0
  return <section className="player">
    <div className="player-info">
      <div className={'player-art' + (isPlaying && !buffering ? ' spin' : '')}>{ICONS.note}</div>
      <div className="player-meta">
        <strong>{current?.title || 'Yayın hazır'}</strong>
        <span className={buffering ? 'player-buffering' : ''}>{buffering ? 'Bağlanıyor…' : (current?.artist || 'Müzik ekleyerek başlayın')}</span>
      </div>
    </div>
    <div className="player-main">
      <div className="player-buttons">
        <button className={'pbtn' + (pb.shuffle ? ' on' : '')} title={pb.shuffle ? 'Karıştırma açık' : 'Karıştırma kapalı'} onClick={() => save({ playback: { shuffle: !pb.shuffle } })}>{ICONS.shuffle}</button>
        <button className="pbtn" title="Önceki" onClick={() => control('previous')}>{ICONS.prev}</button>
        <button className="pbtn play" title={isPlaying ? 'Duraklat' : 'Oynat'} onClick={() => control(isPlaying ? 'pause' : 'play')}>{isPlaying ? ICONS.pause : ICONS.play}</button>
        <button className="pbtn" title="Sonraki" onClick={() => control('next')}>{ICONS.next}</button>
        <button className="pbtn" title="Durdur" onClick={() => control('stop')}>{ICONS.stop}</button>
      </div>
      <div className="player-seek">
        <span className="ptime">{fmt(shownVal)}</span>
        <input className="pbar" style={{ '--pct': pct + '%' }} type="range" min="0" max={duration || 1} step="1" value={shownVal} disabled={!duration} onChange={e => { lastSentRef.current = null; setDragValue(Number(e.target.value)) }} onPointerUp={commitSeek} onMouseUp={commitSeek} onTouchEnd={commitSeek} onKeyUp={commitSeek} aria-label="Parça konumu"/>
        <span className="ptime">{duration ? fmt(duration) : '--:--'}</span>
      </div>
    </div>
    <div className="player-side" title="Bu bilgisayarın sesi — yalnızca burada">
      <span className="pvol-ic">{ICONS.vol}</span>
      <input className="pvol" type="range" min="0" max="100" value={localVol} onChange={e => onLocalVol(Number(e.target.value))} aria-label="Bu bilgisayar sesi"/>
      <b className="pvol-val">{localVol}</b>
    </div>
  </section>
}

// Sırada. The upcoming order was already being computed and sent on every update, and nothing
// displayed it. Showing it costs nothing and answers a question the operator asks constantly
// — is the next song right for the room? — early enough to do something about it.
// The one line that says the café has gone silent. It was a hardcoded green sentence until
// recently; now that it tells the truth, it also has to reach an operator who is not looking
// at it. `role="status"` makes a screen reader announce the text when it CHANGES — so the
// steady "aktif" line is silent, and the moment it turns into a fault it is spoken.
//
// One region for both states, deliberately: a message that moved between two elements would
// read as two separate things appearing rather than one state changing.
function BroadcastNotice({ station }) {
  const broken = station.capabilities.flowing === false
  return <section className="card notices">
    <h2>Yayın Durumu</h2>
    <p role="status" className={broken ? 'bad' : 'ok'}>{station.capabilities.message}</p>
    <p className="muted">Hedef gecikme: yaklaşık {station.timing.targetLatencySeconds} sn</p>
    <p className="muted">Telefonlar aynı Wi‑Fi ağında olmalıdır.</p>
  </section>
}

function UpNext({ station }) {
  const queue = (station.nextMusic || []).slice(0, 5)
  if (!queue.length) return null
  return <section className="card up-next">
    <div className="card-title"><h2>Sırada</h2><span>{station.nextMusic.length}</span></div>
    <div className="up-next-list">
      {queue.map((track, index) => <span key={track.id} className="up-next-item">
        <b>{index + 1}</b> {track.title}
      </span>)}
    </div>
  </section>
}

function TrackList({ title, items, currentId, playing, onPlay }) {
  return <section className="card list-card">
    <div className="card-title"><h2>{title}</h2><span>{items.length}</span></div>
    <div className="track-list">
      {items.length ? items.map(item => {
        const now = item.id === currentId
        return <button key={item.id} className={'track-row' + (now ? ' now' : '')} onClick={() => onPlay(item.id)} title="Bu parçayı çal">
          <span className="track-ic">{now ? <span className={'eq' + (playing ? ' on' : '')}><i/><i/><i/></span> : ICONS.noteSmall}</span>
          <span className="track-name">{item.title}</span>
          <small>{item.durationSeconds ? fmt(item.durationSeconds) : ''}</small>
        </button>
      }) : <p className="empty">Henüz yok — “Klasörü Aç” ile ekleyin.</p>}
    </div>
  </section>
}

const IL_LIST = ['Adana', 'Adıyaman', 'Afyonkarahisar', 'Ağrı', 'Aksaray', 'Amasya', 'Ankara', 'Antalya', 'Ardahan', 'Artvin', 'Aydın', 'Balıkesir', 'Bartın', 'Batman', 'Bayburt', 'Bilecik', 'Bingöl', 'Bitlis', 'Bolu', 'Burdur', 'Bursa', 'Çanakkale', 'Çankırı', 'Çorum', 'Denizli', 'Diyarbakır', 'Düzce', 'Edirne', 'Elazığ', 'Erzincan', 'Erzurum', 'Eskişehir', 'Gaziantep', 'Giresun', 'Gümüşhane', 'Hakkari', 'Hatay', 'Iğdır', 'Isparta', 'İstanbul', 'İzmir', 'Kahramanmaraş', 'Karabük', 'Karaman', 'Kars', 'Kastamonu', 'Kayseri', 'Kırıkkale', 'Kırklareli', 'Kırşehir', 'Kilis', 'Kocaeli', 'Konya', 'Kütahya', 'Malatya', 'Manisa', 'Mardin', 'Mersin', 'Muğla', 'Muş', 'Nevşehir', 'Niğde', 'Ordu', 'Osmaniye', 'Rize', 'Sakarya', 'Samsun', 'Siirt', 'Sinop', 'Sivas', 'Şanlıurfa', 'Şırnak', 'Tekirdağ', 'Tokat', 'Trabzon', 'Tunceli', 'Uşak', 'Van', 'Yalova', 'Yozgat', 'Zonguldak']

function EzanBanner({ station }) {
  const ez = station.ezan
  if (!ez?.active) return null
  return <div className="ezan-banner"><span className="ezan-moon">☪</span><div className="ezan-banner-txt"><strong>Ezan Vakti — {ez.activePrayer}</strong><span>Müzik geçici olarak durduruldu. Ezan bitince otomatik devam edecek — sıkıntı yok.</span></div></div>
}

function EzanCard({ station, save }) {
  const ez = station.ezan || {}
  const [ilce, setIlce] = useState(ez.ilce || '')
  useEffect(() => { setIlce(ez.ilce || '') }, [ez.ilce])
  const commitIlce = () => { if (ilce.trim() !== (ez.ilce || '')) save({ ezan: { ilce: ilce.trim() } }) }
  return <section className="card ezan-card">
    <div className="ezan-head">
      <div><h2>Ezan Vaktinde Duraklat</h2><p className="muted">Ezan boyunca müzik otomatik durur, sonra kaldığı yerden devam eder.</p></div>
      <label className="switch"><input type="checkbox" aria-label="Ezan vaktinde müziği otomatik duraklat" checked={!!ez.enabled} onChange={e => save({ ezan: { enabled: e.target.checked } })}/><span className="slider"/></label>
    </div>
    {ez.enabled && <>
      <div className="ezan-fields">
        <div className="field"><label htmlFor="ezan-il">İl</label><select id="ezan-il" value={ez.il || 'İstanbul'} onChange={e => save({ ezan: { il: e.target.value } })}>{IL_LIST.map(il => <option key={il} value={il}>{il}</option>)}</select></div>
        <div className="field"><label htmlFor="ezan-ilce">İlçe</label><input id="ezan-ilce" value={ilce} onChange={e => setIlce(e.target.value)} onBlur={commitIlce} onKeyDown={e => e.key === 'Enter' && commitIlce()} placeholder="(opsiyonel)"/></div>
        <div className="field"><label htmlFor="ezan-sure">Durma süresi</label><div className="dk"><input id="ezan-sure" type="number" min="1" max="60" value={ez.durationMinutes || 8} onChange={e => save({ ezan: { durationMinutes: Number(e.target.value) } })}/><span>dk</span></div></div>
      </div>
      {Object.keys(ez.times || {}).length ? <div className="ezan-times">{Object.entries(ez.times).map(([k, v]) => <span key={k} className={ez.active && ez.activePrayer === k ? 'on' : ''}><b>{k}</b> {v}</span>)}</div> : <p className="muted">Bugünün vakitleri çekiliyor…</p>}
      {ez.lastError && <p role="status" className="warn">Vakitler alınamadı ({ez.lastError}). İnternet bağlantısını kontrol edin.</p>}
    </>}
  </section>
}

// Yayın sesi üst sınırı. 100 = parçanın eşitlenmiş kendi seviyesi; üstü bilinçli
// yükseltme bölgesi (200 = iki katı). Sunucudaki MAX_VOLUME ile aynı kalmalı.
// DİKKAT: bu yalnızca YAYIN kaydırıcıları içindir. Cihazın kendi ses ayarı (bu
// bilgisayarın/telefonun sesi) 100'de kalmak zorunda — tarayıcı <audio>.volume
// değerini 1.0 ile sınırlıyor, üstü sessizce yok sayılır.
const MAX_VOLUME = 200
// One row per broadcast volume (music, ad) — each independent, synced to every
// screen, applied live in the server mixer (no encoder/decoder restart).
function VolumeRow({ label, value, onChange }) {
  const [v, setV] = useState(value)
  useEffect(() => { setV(value) }, [value])
  const t = useRef()
  const last = useRef(0)
  // Throttle, not debounce. Debouncing meant nothing was sent until the operator stopped
  // moving the slider, so the sound only followed after they let go. Now the level is
  // sent while dragging (at most every 100ms), with a trailing send so the final
  // resting position always lands.
  const on = val => {
    setV(val)
    clearTimeout(t.current)
    const since = Date.now() - last.current
    if (since >= 100) { last.current = Date.now(); onChange(val) }
    else t.current = setTimeout(() => { last.current = Date.now(); onChange(val) }, 100 - since)
  }
  return <div className="master-row">
    <span className="master-label">{ICONS.vol} {label}</span>
    <input className="master-range" type="range" min="0" max={MAX_VOLUME} value={v} onChange={e => on(Number(e.target.value))} aria-label={label}/>
    <b className={'master-val' + (v > 100 ? ' boost' : '')}>{v}</b>
  </div>
}
function MasterBar({ station, control }) {
  return <section className="card master-bar">
    <VolumeRow label="Müzik Sesi" value={station.playback.musicVolume ?? 100} onChange={v => control('musicVolume', v)}/>
    <VolumeRow label="Reklam Sesi" value={station.playback.adVolume ?? 100} onChange={v => control('adVolume', v)}/>
    <span className="master-hint">tüm cihazlarda senkron</span>
  </section>
}

function Dashboard({ station, control, setView, mic, audioRef, monitorReady, localVol, onLocalVol }) {
  const ads = station.adSettings
  const save = payload => api('/api/settings', { method: 'PATCH', body: JSON.stringify(payload) })
  // Music level while the mic is on. This IS broadcast-wide (server mix), so the
  // slider applies to the PC monitor AND every phone at once.
  const [musicUnderMic, setMusicUnderMic] = useState(100 - Number(station.microphone?.ducking ?? 35))
  useEffect(() => { setMusicUnderMic(100 - Number(station.microphone?.ducking ?? 35)) }, [station.microphone?.ducking])
  const duckTimer = useRef()
  const onMusicUnderMic = v => { setMusicUnderMic(v); clearTimeout(duckTimer.current); duckTimer.current = setTimeout(() => save({ microphone: { ducking: 100 - v } }), 150) }
  return <><EzanBanner station={station}/><Player station={station} control={control} save={save} audioRef={audioRef} monitorReady={monitorReady} localVol={localVol} onLocalVol={onLocalVol}/><MasterBar station={station} control={control}/><UpNext station={station}/><section className="cards-row"><section className="card ad-settings"><div className="card-title"><h2>Reklam Otomasyonu</h2><button className="outline" onClick={() => control('manualAd')}>Şimdi Reklam Çal</button></div><label className="switch-row"><input type="checkbox" checked={ads.songsEnabled} onChange={e => save({ adSettings: { songsEnabled: e.target.checked, ...(e.target.checked ? { timedEnabled: false } : {}) } })}/> Her <input className="number" type="number" min="1" aria-label="Kaç şarkıda bir reklam" value={ads.songsEvery} onChange={e => save({ adSettings: { songsEvery: Number(e.target.value) } })}/> şarkıda bir</label><label className="switch-row"><input type="checkbox" checked={ads.timedEnabled} onChange={e => save({ adSettings: { timedEnabled: e.target.checked, ...(e.target.checked ? { songsEnabled: false } : {}) } })}/> Her <input className="number" type="number" min="1" aria-label="Kaç dakikada bir reklam" value={ads.timedMinutes} onChange={e => save({ adSettings: { timedMinutes: Number(e.target.value) } })}/> dakikada bir</label></section><section className="card mic-card"><div className="card-title"><h2>Canlı Anons</h2><span>{station.microphone?.enabled ? 'Açık' : 'Hazır'}</span></div><label className="volume">Anonsta müzik <input type="range" min="0" max="100" value={musicUnderMic} onChange={e => onMusicUnderMic(Number(e.target.value))}/><b>{musicUnderMic}%</b></label><p className="muted">Bu ayar tüm cihazlarda (telefon + bilgisayar) geçerlidir.</p><button className="primary wide" onClick={() => mic?.()}>{station.microphone?.enabled ? 'Anonsu Bitir' : 'Mikrofonla Anons Yap'}</button></section></section><EzanCard station={station} save={save}/><section className="cards-row"><TrackList title="Müzikler" items={station.music} currentId={station.playback.currentId} playing={station.playback.status === 'playing'} onPlay={id => control('playTrack', id)}/><TrackList title="Reklamlar" items={station.ads} currentId={station.playback.currentId} playing={station.playback.status === 'playing'} onPlay={id => control('playTrack', id)}/></section><div className="library-tabs"><button onClick={() => setView('music')}>Müzik Kütüphanesini Aç</button><button onClick={() => setView('ad')}>Reklamları Aç</button></div></>
}

// Yönetici kodunu YALNIZCA kafenin kendi bilgisayarında gösterir — sunucu bu ucu
// localhost dışına kapatıyor. Kod telefonlara indirilen dosyada bulunmuyor.
// İstasyon Günlüğü. The station already records everything worth knowing — a file it cannot
// read, a track it had to skip, an ezan pause it cancelled, an engine that restarted itself —
// and until now it showed none of it. The operator's only signal was the music itself, which
// makes every failure look identical: something is wrong and there is no way to find out what.
//
// System entries are what matter here, so they are the default view; the music/ad log is
// available behind a toggle for "what has been playing".
function HistoryCard({ station }) {
  const [onlyIssues, setOnlyIssues] = useState(true)
  const entries = station.history || []
  const shown = (onlyIssues ? entries.filter(e => e.type === 'system' || e.type === 'microphone') : entries).slice(0, 25)
  const clock = at => {
    try { const d = new Date(at); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }
    catch { return '' }
  }
  return <section className="card history-card">
    <div className="card-title">
      <h2>İstasyon Günlüğü</h2>
      <button className="outline" onClick={() => setOnlyIssues(v => !v)}>
        {onlyIssues ? 'Tümü' : 'Sadece olaylar'}
      </button>
    </div>
    {shown.length
      ? <div className="history-list">
          {shown.map(entry => <div key={entry.id} className={'history-row ' + entry.type}>
            <span className="history-time">{clock(entry.at)}</span>
            <span className="history-text">{entry.title}</span>
          </div>)}
        </div>
      : <p className="muted">{onlyIssues ? 'Kayda değer bir olay yok — her şey yolunda.' : 'Henüz kayıt yok.'}</p>}
  </section>
}

// Güncelleme kartı. The café PC is far away, so this button is how a fix actually gets there.
// It never installs on its own: applying an update stops the music and raises a Windows
// permission prompt, so the person standing in the café picks the moment.
function UpdateCard() {
  const [status, setStatus] = useState(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let ok = true
    const read = () => api('/api/update/status').then(r => ok && setStatus(r)).catch(() => ok && setStatus(null))
    read()
    // While a download is running the operator wants to see it move; otherwise this is a
    // once-a-minute glance, not a poll worth paying for.
    const timer = setInterval(read, 20000)
    return () => { ok = false; clearInterval(timer) }
  }, [])
  if (!status) return null

  const install = async () => {
    if (!window.confirm('Güncelleme kurulacak.\n\n• Yayın birkaç dakika kesilecek\n• Windows izin penceresi çıkacak, "Evet" deyin\n• Kurulum bitince program kendiliğinden açılacak\n\nDevam edilsin mi?')) return
    setBusy(true)
    try { await api('/api/update/install', { method: 'POST' }) }
    catch (error) {
      let message = 'Güncelleme başlatılamadı.'
      try { message = JSON.parse(String(error.message)).error || message } catch {}
      alert(message)
      setBusy(false)
    }
  }
  const check = async () => {
    setBusy(true)
    try { setStatus(await api('/api/update/check', { method: 'POST' })) } catch {}
    finally { setBusy(false) }
  }

  return <section className="card update-card">
    <div className="card-title"><h2>Program Sürümü</h2><span>{status.version}</span></div>
    {!status.supported
      ? <p className="muted">{status.reason || 'Bu kurulumda güncelleme kapalı.'}</p>
      : status.downloaded
        ? <>
            <p className="ok">Yeni sürüm hazır: <b>{status.newVersion}</b></p>
            <button className="primary wide" disabled={busy} onClick={install}>{busy ? 'Kuruluyor…' : 'Şimdi Güncelle'}</button>
            <p className="muted">Kurulum sırasında yayın kısa süre kesilir.</p>
          </>
        : status.downloading
          ? <p className="muted">Yeni sürüm indiriliyor… %{status.percent || 0}</p>
          : <>
              <p className="muted">{status.checking ? 'Kontrol ediliyor…' : 'Program güncel.'}</p>
              <button className="outline" disabled={busy} onClick={check}>Güncelleme Denetle</button>
            </>}
    {status.error && <p className="warn">{status.error}</p>}
  </section>
}

function AdminCodeCard() {
  const [info, setInfo] = useState(null)
  const [busy, setBusy] = useState(false)
  const [shown, setShown] = useState(false)
  useEffect(() => { let ok = true; api('/api/admin/code').then(r => ok && setInfo(r)).catch(() => ok && setInfo(null)); return () => { ok = false } }, [])
  const rotate = async () => {
    if (!window.confirm('Yeni kod üretilsin mi? Şu an giriş yapmış telefonların yetkisi kalkar.')) return
    setBusy(true)
    try { const r = await api('/api/admin/rotate', { method: 'POST' }); setInfo(cur => ({ ...cur, code: r.code })); setShown(true) }
    catch { alert('Yeni kod üretilemedi') }
    finally { setBusy(false) }
  }
  if (!info) return null
  return <section className="card admin-code-card">
    <div className="card-title"><h2>Yönetici Kodu</h2><button className="outline" onClick={() => setShown(s => !s)}>{shown ? 'Gizle' : 'Göster'}</button></div>
    <p className="admin-code-value">{shown ? info.code : '••••••'}</p>
    <p className="muted">Telefondan yönetici olmak için logoya 5 kez dokunup bu kodu girin. Kod bu ekran dışında hiçbir yerde görünmez.</p>
    {info.fromEnv
      ? <p className="muted">Kod ADMIN_CODE ayarından geliyor.</p>
      : <button className="outline wide" disabled={busy} onClick={rotate}>{busy ? 'Üretiliyor…' : 'Yeni Kod Üret'}</button>}
  </section>
}

function ConnectCard({ station }) {
  const [qr, setQr] = useState(null)
  const [ipError, setIpError] = useState(null)
  useEffect(() => { let ok = true; api('/api/qr').then(r => ok && setQr(r.dataUrl)).catch(() => ok && setQr(null)); return () => { ok = false } }, [station.network.webUrl])
  const net = station.network
  const multi = net.ips?.length > 1
  // Which address have phones ACTUALLY arrived on? With two networks in the café this is the
  // difference between guessing and knowing: the server records the interface each request
  // came in on, so the panel can name the address that works instead of asking the operator
  // to try combinations while customers wait.
  const reached = net.reachedVia || []
  const chooseIp = async value => {
    setIpError(null)
    try { await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ station: { preferredIp: value } }) }) }
    catch (error) {
      // The server refuses an address this machine no longer has (Wi-Fi dropped, router
      // changed). Show that instead of letting the dropdown snap back for no visible reason.
      let message = 'Ağ adresi değiştirilemedi.'
      try { message = JSON.parse(String(error.message)).error || message } catch {}
      setIpError(message)
    }
  }
  return <section className="card connect-card">
    <div className="card-title"><h2>Telefonla Bağlan</h2></div>
    {qr ? <img className="qr" src={qr} alt="Bağlantı QR kodu" width={200} height={200}/> : <p className="muted">QR hazırlanıyor…</p>}
    <p className="muted">Telefon kamerasıyla okutun</p>
    <a className="connect-url" href={net.webUrl} target="_blank" rel="noreferrer">{net.webUrl}</a>
    <a className="connect-url admin-link" href={net.adminUrl} target="_blank" rel="noreferrer">Yönetici / anons (HTTPS): {net.adminUrl}</a>
    {net.preferredMissing && <p className="warn">Seçtiğiniz ağ adresi ({net.preferredIp}) bu bilgisayarda artık yok — yayın şu an {net.ip} üzerinden veriliyor. Aşağıdan doğru adresi seçin.</p>}
    {multi && <label className="ip-select">Ağ adresi<select value={net.ip} onChange={e => chooseIp(e.target.value)}>{net.ips.map(x => <option key={x.ip} value={x.ip}>{x.ip} — {x.name}</option>)}</select></label>}
    {ipError && <p className="warn">{ipError}</p>}
    {multi && <p className="muted">Telefonlar bağlanamıyorsa buradan doğru Wi‑Fi ağ adresini seçin.</p>}
    {/* The station listens on EVERY address the PC has, so each of these is live — the QR
        can only show one at a time. When a café has two networks, the fastest way to find
        the one the phones are on is to type them into a phone until one opens. */}
    {/* The one explanation the panel could never give: Windows blocking the station on this
        network. It goes above the address list because it makes every address below it
        useless — trying them one by one is wasted effort until this is fixed. */}
    {net.firewall?.problem && <p role="status" className="bad">{net.firewall.message}</p>}
    {multi && <div className="all-urls">
      <span className="mtl-label">Telefonda deneyebileceğiniz adresler</span>
      {net.ips.map(x => <code key={x.ip}>http://{x.ip}:{net.port || 8090}/listen<small> — {x.name}</small></code>)}
    </div>}
    {multi && (reached.length
      ? <p className="ok reached-note">Telefonlar şu adres(ler) üzerinden bağlandı: {reached.map(r => r.ip).join(', ')}{reached.some(r => r.ip === net.ip) ? '' : ' — QR başka bir adresi gösteriyor, yukarıdan bunu seçin.'}</p>
      : <p className="muted reached-note">Henüz hiçbir telefon bağlanamadı. Telefonun, bu bilgisayarla <b>aynı Wi‑Fi ağında</b> olduğundan emin olun.</p>)}
  </section>
}

function Admin() {
  const station = useStation(); const [view, setView] = useState('home'); const audio = useRef(); const micRef = useRef(null); const [monitorReady, setMonitorReady] = useState(false)
  // This PC's own local trim (per-device, saved in localStorage). The master
  // broadcast level is already baked into the stream server-side.
  // `Number(null)` is 0 (not NaN), so the old guard read an unset store as volume 0 — the PC
  // monitor opened muted on a fresh machine. Only trust a value that was actually stored.
  const [localVol, setLocalVol] = useState(() => { const raw = localStorage.getItem('cr_local_vol'); const v = raw == null ? NaN : Number(raw); return Number.isFinite(v) && v >= 0 && v <= 100 ? v : 100 })
  useEffect(() => { if (audio.current) audio.current.volume = Math.max(0, Math.min(1, localVol / 100)) }, [localVol])
  // The broadcast is now ONE continuous stream (silence when idle), so the monitor
  // never has to reconnect on a track change, seek, or ezan — it just keeps playing
  // and self-heals only on a real network drop. wantPlay tracks operator intent.
  const wantPlay = useRef(false)
  const retryTimer = useRef()
  const reconnect = () => { const a = audio.current; if (!a || !wantPlay.current) return; try { a.load(); a.play().catch(() => {}) } catch {} }
  const scheduleReconnect = () => { if (!wantPlay.current) return; clearTimeout(retryTimer.current); retryTimer.current = setTimeout(reconnect, 1200) }
  useEffect(() => () => { clearTimeout(retryTimer.current); micRef.current?.stop?.() }, [])
  useLiveEdge(audio)
  const control = async (action, value) => {
    await api('/api/control', { method: 'POST', body: JSON.stringify({ action, value }) })
    if (action === 'play') { wantPlay.current = true; audio.current?.play().catch(() => {}) }
    if (['pause', 'stop'].includes(action)) { wantPlay.current = false; clearTimeout(retryTimer.current); audio.current?.pause() }
    // The continuous stream keeps every device in sync; no manual reload on track/seek.
  }
  // Keyboard shortcuts for the desk operator: Space = play/pause, ←/→ = prev/next.
  useEffect(() => {
    const onKey = event => {
      const tag = event.target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON' || tag === 'A') return
      if (event.code === 'Space') { event.preventDefault(); control(station?.playback.status === 'playing' ? 'pause' : 'play') }
      else if (event.code === 'ArrowRight') control('next')
      else if (event.code === 'ArrowLeft') control('previous')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [station?.playback.status])
  if (!station) return <main className="loading">Rovli Radio hazırlanıyor...</main>
  // Monitör göreli /live.mp3 kullanıyor: kafe bilgisayarı kendi sesini LAN arayüzünden
  // dolaştırmak yerine doğrudan loopback üzerinden alır.
  const changeLocalVol = v => { setLocalVol(v); try { localStorage.setItem('cr_local_vol', String(v)) } catch {}; if (audio.current) audio.current.volume = Math.max(0, Math.min(1, v / 100)) }
  const toggleMic = async () => {
    if (station.microphone?.enabled || micRef.current) { const m = micRef.current; micRef.current = null; await m?.stop?.() }
    else {
      const m = createMicStreamer({ onDropped: message => { micRef.current = null; alert(message) } })
      try { await m.start(); micRef.current = m }
      catch (err) { micRef.current = null; const msg = String(err?.message || err).slice(0, 140); alert('Mikrofona erişilemedi: ' + msg + '\n(Yönetim panelini bilgisayarda/Electron üzerinde açın; tarayıcıda mikrofon için 127.0.0.1 veya HTTPS gerekir.)') }
    }
  }
  return <main className="admin-shell"><audio ref={audio} preload="none" src="/live.mp3" onPlaying={() => setMonitorReady(true)} onWaiting={() => setMonitorReady(false)} onStalled={() => { setMonitorReady(false); scheduleReconnect() }} onError={scheduleReconnect} onPause={() => setMonitorReady(false)} onEnded={() => { setMonitorReady(false); scheduleReconnect() }}/><header><div className="brand"><div className="brand-mark">R</div><div><h1 className="brand-title">Rovli Radio</h1><span>Rovli Coffee Müzik ve Anons Sistemi</span></div></div><div className="network"><i></i><span>{station.network.ip}:{station.network.port || 8090}</span><small>Yerel ağ yayını</small></div></header><div className="dashboard"><aside className="sidebar"><nav aria-label="Bölümler"><button className={'nav ' + (view === 'home' ? 'active' : '')} onClick={() => setView('home')}>Genel Bakış</button><button className={'nav ' + (view === 'music' ? 'active' : '')} onClick={() => setView('music')}>Müzik Kütüphanesi</button><button className={'nav ' + (view === 'ad' ? 'active' : '')} onClick={() => setView('ad')}>Reklamlar</button></nav><div className="sidebar-foot"><span>Dinleyici</span><strong>{station.listeners} kişi</strong></div></aside><div className="content">{view === 'home' ? <Dashboard station={station} control={control} setView={setView} mic={toggleMic} audioRef={audio} monitorReady={monitorReady} localVol={localVol} onLocalVol={changeLocalVol}/> : <Library station={station} kind={view}/>}</div><aside className="rightbar"><ConnectCard station={station}/><AdminCodeCard/><UpdateCard/><HistoryCard station={station}/><BroadcastNotice station={station}/></aside></div></main>
}

function Listener() {
  const station = useStation(); const [playing, setPlaying] = useState(false); const audio = useRef(); const micRef = useRef(null); const tapRef = useRef(0); const tapTimer = useRef(); const actx = useRef(null); const gain = useRef(null)
  const listenerId = useMemo(() => crypto.randomUUID?.() || String(Date.now()), [])
  // This phone's own volume — local playback gain, independent of the PC and every other phone.
  // `Number(null)` is 0, not NaN — so the old guard accepted "nothing saved" as volume 0, and
  // every phone opening the page for the FIRST time started muted with the slider at 0%. Read
  // the raw value and only trust it when something was actually stored.
  const [vol, setVol] = useState(() => { const raw = localStorage.getItem('cr_listen_vol'); const v = raw == null ? NaN : Number(raw); return Number.isFinite(v) && v >= 0 && v <= 100 ? v : 100 })
  const [admin, setAdmin] = useState(() => { try { return !!localStorage.getItem('cr_admin_token') } catch { return false } })
  const [miking, setMiking] = useState(false)
  useEffect(() => { const onExpired = () => setAdmin(false); window.addEventListener('cr-admin-expired', onExpired); return () => window.removeEventListener('cr-admin-expired', onExpired) }, [])
  // Broadcast music/ad levels (synced) — editable from the phone admin panel.
  const [musicVolLocal, setMusicVolLocal] = useState(100); const musicVolTimer = useRef()
  const [adVolLocal, setAdVolLocal] = useState(100); const adVolTimer = useRef()
  useEffect(() => { setMusicVolLocal(station?.playback.musicVolume ?? 100) }, [station?.playback.musicVolume])
  useEffect(() => { setAdVolLocal(station?.playback.adVolume ?? 100) }, [station?.playback.adVolume])
  useEffect(() => { const beat = () => api('/api/listeners/heartbeat', { method: 'POST', body: JSON.stringify({ id: listenerId }) }).catch(() => {}); beat(); const id = setInterval(beat, 15000); return () => clearInterval(id) }, [listenerId])
  // Local per-phone trim. We deliberately do NOT route the element through a Web Audio
  // MediaElementSource graph: on mobile (esp. iOS) that makes the OS SUSPEND the AudioContext
  // when the screen locks or the tab backgrounds, which silences playback and reads as a
  // "disconnect" during long silences. A plain <audio> keeps streaming on the lock screen
  // like any web-radio player. Cost: iOS ignores <audio>.volume (hardware buttons); Android
  // still honours it here. (The master broadcast level is already baked into the stream.)
  const applyVol = v => { if (audio.current) audio.current.volume = Math.max(0, Math.min(1, v / 100)) }
  useEffect(() => { applyVol(vol) }, [vol])
  // Intent flag: true once the user asked for live audio, false only when THEY pause.
  // We use it (not the element's paused state) to decide when to auto-reconnect, so a
  // network hiccup or an ezan gap that pauses the element still recovers on its own.
  const wantPlay = useRef(false)
  const retryTimer = useRef()
  const reconnect = () => { const a = audio.current; if (!a || !wantPlay.current) return; try { a.load(); a.play().catch(() => {}) } catch {} }
  // Live streams stall when the server briefly stops sending (track change, ezan,
  // Wi-Fi blip). The browser won't resume by itself — so we re-request the stream.
  const scheduleReconnect = () => { if (!wantPlay.current || station?.ezan?.active) return; clearTimeout(retryTimer.current); retryTimer.current = setTimeout(reconnect, 1200) }
  useEffect(() => () => { clearTimeout(retryTimer.current); micRef.current?.stop?.(); try { actx.current?.close() } catch {} }, [])
  useLiveEdge(audio)
  // The broadcast is ONE continuous stream: during ezan the server sends silence, then music,
  // on the SAME connection. A phone that is still playing therefore resumes on its own.
  // Nudging it is harmful: reconnect() calls audio.load(), tearing down the healthy connection,
  // and the follow-up play() has no user gesture so mobile browsers block it — which left the
  // phone silent after ezan (the PC monitor has no such effect, which is why only phones failed).
  // Only reconnect if the element actually stalled during the window.
  const ezanRef = useRef(false)
  useEffect(() => {
    const active = !!station?.ezan?.active
    if (ezanRef.current && !active) {
      const a = audio.current
      if (a && wantPlay.current && (a.paused || a.readyState < 3)) reconnect()
    }
    ezanRef.current = active
  }, [station?.ezan?.active])
  // After redirecting to the HTTPS admin page, offer the unlock prompt straight away.
  useEffect(() => {
    let stored = false
    try { stored = !!localStorage.getItem('cr_admin_token') } catch {}
    if (location.hash !== '#admin' || stored) return
    promptAdminLogin().then(ok => { if (ok) setAdmin(true); try { history.replaceState(null, '', location.pathname) } catch {} })
  }, [])
  // Mobile lock-screen / backgrounding (THE long-silence disconnect): when a phone locks its
  // screen — most likely during a quiet stretch — the OS pauses the element and won't resume
  // it on its own. On every return to the foreground, re-assert playback if the user still
  // wants audio; if the element is truly stale, fall back to a full reconnect.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || !wantPlay.current) return
      const a = audio.current
      if (a && a.paused) { try { a.play().catch(() => scheduleReconnect()) } catch {} }
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('pageshow', onVisible)   // iOS Safari restores from bfcache via pageshow
    return () => { document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('pageshow', onVisible) }
  }, [])
  // MediaSession: declare the stream as background media so the OS shows lock-screen controls
  // and keeps audio alive when the screen is off, and wire those buttons back to our element.
  useEffect(() => {
    const ms = navigator.mediaSession
    if (!ms || !window.MediaMetadata) return
    try {
      ms.setActionHandler('play', () => { wantPlay.current = true; audio.current?.play().catch(() => {}) })
      ms.setActionHandler('pause', () => { wantPlay.current = false; audio.current?.pause() })
    } catch {}
  }, [])
  useEffect(() => {
    const ms = navigator.mediaSession
    if (!ms || !window.MediaMetadata) return
    const cur = station?.current
    try { ms.metadata = new window.MediaMetadata({ title: cur?.title || 'Rovli Radio', artist: 'Rovli Coffee', album: 'Canlı Yayın' }) } catch {}
    try { ms.playbackState = playing ? 'playing' : 'paused' } catch {}
  }, [station?.current?.id, playing])
  if (!station) return <main className="loading">Bağlanıyor...</main>
  const changeVol = v => { setVol(v); try { localStorage.setItem('cr_listen_vol', String(v)) } catch {}; applyVol(v) }
  // Intentionally a no-op: see applyVol. Routing playback through a Web Audio
  // MediaElementSource graph is exactly what made mobile audio die on screen-lock /
  // backgrounding; a plain <audio> element survives the lock screen.
  const ensureGraph = () => {}
  const toggle = () => { ensureGraph(); if (playing) { wantPlay.current = false; clearTimeout(retryTimer.current); audio.current?.pause() } else { wantPlay.current = true; audio.current?.play().catch(() => {}) } }
  const control = async (action, value) => {
    try { await api('/api/control', { method: 'POST', body: JSON.stringify({ action, value }) }) } catch {}
    // Track/seek re-sync is handled by the monitor effect (fires on state change).
  }
  const onMusicVolMobile = v => { setMusicVolLocal(v); clearTimeout(musicVolTimer.current); musicVolTimer.current = setTimeout(() => control('musicVolume', v), 200) }
  const onAdVolMobile = v => { setAdVolLocal(v); clearTimeout(adVolTimer.current); adVolTimer.current = setTimeout(() => control('adVolume', v), 200) }
  const secretTap = () => {
    tapRef.current += 1
    clearTimeout(tapTimer.current); tapTimer.current = setTimeout(() => { tapRef.current = 0 }, 1800)
    if (tapRef.current >= 5) {
      clearTimeout(tapTimer.current); tapRef.current = 0
      promptAdminLogin().then(ok => { if (ok) setAdmin(true) })
    }
  }
  const exitAdmin = () => { if (micRef.current) { micRef.current.stop?.(); micRef.current = null; setMiking(false) } adminLogout(); setAdmin(false) }
  const toggleMic = async () => {
    if (miking || micRef.current) { const m = micRef.current; micRef.current = null; setMiking(false); await m?.stop?.(); return }
    if (!window.isSecureContext) { if (window.confirm('Anons için güvenli bağlantı gerekli. Yönetici (HTTPS) sayfasına geçilsin mi?')) location.href = station.network.adminUrl + '#admin'; return }
    // If the announcement dies on its own mid-sentence (session expired), reset the button
    // and say so — otherwise the panel keeps offering "Anonsu Bitir" for a dead microphone.
    const m = createMicStreamer({ onDropped: message => { micRef.current = null; setMiking(false); alert(message) } })
    try { await m.start(); micRef.current = m; setMiking(true) }
    catch (err) { micRef.current = null; setMiking(false); alert('Mikrofon açılamadı: ' + String(err?.message || err).slice(0, 140)) }
  }
  return <main className="listener"><EzanBanner station={station}/><div className="listener-logo" role="button" tabIndex={0} aria-label="Rovli" onClick={secretTap} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); secretTap() } }} title="">R</div><h1 className="eyebrow">ROVLI RADIO</h1><p className="muted" style={{ marginTop: -10, marginBottom: 4 }}>Rovli Coffee Müzik ve Anons Sistemi</p><Status station={station} compact/><audio ref={audio} src="/live.mp3" preload="none" onPlay={() => setPlaying(true)} onPlaying={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => { setPlaying(false); scheduleReconnect() }} onStalled={scheduleReconnect} onError={scheduleReconnect}/><button className="listen-button" onClick={toggle}>{playing ? 'Duraklat' : 'Canlı Dinlemeye Başla'}</button><label className="volume listener-volume">Ses <input type="range" min="0" max="100" value={vol} onChange={e => changeVol(Number(e.target.value))} disabled={IS_IOS}/><b>{vol}%</b></label>{IS_IOS && <p className="muted ios-vol-note">iPhone/iPad'de uygulama ses çubuğu çalışmaz — sesi telefonun yan tuşlarıyla ayarlayın.</p>}<p className="muted">Canlı radyo — tüm dinleyiciler aynı yayında.</p><Progress station={station}/>{admin && <section className="card admin-mobile"><div className="card-title"><h2>Yönetici</h2><button className="outline" onClick={exitAdmin}>Çık</button></div><div className="transport"><button onClick={() => control('previous')}>&lt;&lt;</button><button className="primary" onClick={() => control(station.playback.status === 'playing' ? 'pause' : 'play')}>{station.playback.status === 'playing' ? 'II' : 'PLAY'}</button><button onClick={() => control('next')}>&gt;&gt;</button><button onClick={() => control('stop')}>STOP</button></div><label className="volume master-vol">Müzik Sesi <input type="range" min="0" max={MAX_VOLUME} value={musicVolLocal} onChange={e => onMusicVolMobile(Number(e.target.value))}/><b className={musicVolLocal > 100 ? 'boost' : ''}>{musicVolLocal}</b></label><label className="volume master-vol">Reklam Sesi <input type="range" min="0" max={MAX_VOLUME} value={adVolLocal} onChange={e => onAdVolMobile(Number(e.target.value))}/><b className={adVolLocal > 100 ? 'boost' : ''}>{adVolLocal}</b></label><div className="mobile-actions"><button className="outline wide" onClick={() => control('manualAd')}>Reklam Çal</button><button className="primary wide" onClick={toggleMic}>{miking ? 'Anonsu Bitir' : 'Anons Yap'}</button></div>{!window.isSecureContext && <p className="muted">Anons için güvenli (HTTPS) sayfaya yönlendirileceksiniz.</p>}<div className="mobile-tracklist"><span className="mtl-label">Şarkı Seç</span><div className="track-list">{station.music.length ? station.music.map(m => <button key={m.id} className={'track-row' + (m.id === station.playback.currentId ? ' now' : '')} onClick={() => control('playTrack', m.id)}><span className="track-ic">{m.id === station.playback.currentId ? <span className={'eq' + (station.playback.status === 'playing' ? ' on' : '')}><i/><i/><i/></span> : ICONS.noteSmall}</span><span className="track-name">{m.title}</span></button>) : <p className="empty">Müzik yok</p>}</div></div></section>}<div className="listener-stats"><span>{station.listeners} kişi dinliyor</span><span>Canlı yayın</span></div></main>
}
// Mount only when there is somewhere to mount. Guarding this is what lets the tests import
// this file to exercise a single component: without it, importing the module would try to
// render the whole app (and its network calls) as a side effect.
const rootElement = document.getElementById('root')
if (rootElement) {
  createRoot(rootElement).render(<StrictMode><ErrorBoundary>{location.pathname.startsWith('/listen') ? <Listener/> : <Admin/>}</ErrorBoundary></StrictMode>)
}

// Exported for the tests. Nothing in the app imports this file — it is the entry point — so
// these exports cost the bundle nothing and keep the components reachable.
export { Admin, BroadcastNotice, Listener, ConnectCard, UpdateCard, HistoryCard, UpNext, AdminCodeCard, EzanCard, Player, Progress, Status, TrackList, MasterBar, ErrorBoundary, IS_IOS, adminHeaders }
