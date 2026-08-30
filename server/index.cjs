const express = require('express')
const multer = require('multer')
const QRCode = require('qrcode')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const https = require('https')
const { spawn } = require('child_process')
const selfsigned = require('selfsigned')
const ffmpegBinary = require('ffmpeg-static')
const ffmpegPath = process.resourcesPath && ffmpegBinary.includes('app.asar') ? ffmpegBinary.replace('app.asar', 'app.asar.unpacked') : ffmpegBinary
const { AudioEngine } = require('./audio-engine.cjs')
const { findActiveWindow } = require('./ezan-window.cjs')

const app = express()
const port = Number(process.env.PORT || 8090)
const httpsPort = Number(process.env.HTTPS_PORT || 8443)
const root = process.env.CAFE_RADIO_DATA || path.join(process.cwd(), 'data')
const statePath = path.join(root, 'station.json')
const appRoot = process.resourcesPath
  ? path.join(process.resourcesPath, 'dist')
  : path.join(__dirname, '..', 'dist')
// Self-signed cert enables HTTPS so phones can use getUserMedia (mic announce).
// It lives in the WRITABLE data folder and is minted per install (see ensureCerts), never
// shipped: a key baked into the installer is byte-identical on every machine, so anyone
// holding the installer could impersonate this station's HTTPS page — which is exactly
// the page where the operator types the admin code.
const certDir = path.join(root, 'certs')
const mediaRoots = {
  music: path.join(root, 'Music'),
  ad: path.join(root, 'Ads')
}
// Maps a media-folder kind to its state array key, and the audio files we scan for.
const KIND_KEY = { music: 'music', ad: 'ads' }
// Always look the folder up through this. A bare `mediaRoots[kind]` with `kind` straight
// off the URL also resolves inherited names like "constructor" or "toString" to truthy
// values, which sails past an `if (!mediaRoots[kind])` guard and hands a function where a
// path was expected.
function mediaRootFor(kind) { return Object.hasOwn(mediaRoots, kind) ? mediaRoots[kind] : null }
const SCAN_AUDIO_RE = /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus|weba|wma)$/i
// Ceilings so no single client on the café Wi-Fi can exhaust memory or sockets.
const MAX_SSE_CLIENTS = 120
const MAX_LISTENERS = 400
// Loudness analysis per scan pass (one pass every 15s). Kept small because the analysis
// competes for CPU with the live encoder; a fresh library fills in over a few minutes.
const LOUDNESS_PER_SCAN = 3
// Broadcast volume ceiling. 100 plays a track at its normalised level; above that is
// deliberate boost territory (200 = ×2 = +6 dB). Kept in step with the slider max in
// src/main.jsx and the ceiling in audio-engine.cjs buildChunk().
const MAX_VOLUME = 200
// Shown in the status report so a log can be tied to the build that produced it.
const APP_VERSION = (() => { try { return require('../package.json').version } catch { return 'bilinmiyor' } })()
// Set by startServer() when the desktop app supplies one; null when running from source.
let appUpdater = null
// Ad-scheduling bounds. "Every 0 songs" is the dangerous one: the counter is always >= 0,
// so an ad plays after every advance and the station never returns to music. The UI can
// send it by accident — clearing the number field to retype it yields Number('') === 0.
const MIN_ADS_EVERY = 1
const MAX_ADS_EVERY = 500
// Also bounds the arithmetic: `Date.now() + minutes * 60000` must stay inside the range a
// Date can represent, or toISOString() throws and the stored schedule is corrupted.
const MAX_TIMED_MINUTES = 24 * 60
// How many times a file that cannot be read is re-probed before the station stops trying.
const MAX_PROBE_ATTEMPTS = 3

for (const directory of [root, certDir, ...Object.values(mediaRoots)]) fs.mkdirSync(directory, { recursive: true })

const defaults = {
  station: { name: 'Rovli Radyo', logo: null, port: 8090 },
  playback: { status: 'stopped', musicVolume: 76, adVolume: 76, shuffle: true, loop: true, currentId: null, currentType: null, currentStartedAt: null, currentOffsetSeconds: 0, tracksSinceAd: 0, nextTimedAdAt: null },
  // `scheduled` (clock-time ads) and `recordAnnouncements` used to sit here. Neither was ever
  // read anywhere: no endpoint accepted them, no code branched on them, nothing displayed
  // them. They were saved to disk and broadcast to every phone as settings that promised
  // behaviour the station does not have. Dropping them is not a behaviour change — an old
  // station.json that still carries them keeps them through mergeState and they stay inert.
  adSettings: { songsEnabled: true, songsEvery: 5, timedEnabled: true, timedMinutes: 60, manualResetsCounters: true },
  microphone: { enabled: false, ducking: 35 },
  music: [],
  ads: [],
  queues: { music: [], adCursor: 0 },
  history: [],
  playedStack: [],
  // `prevStatus` remembers what the station was doing before the ezan silenced it. It lives
  // in the persisted state, not in a module variable: an app restart during a prayer window
  // used to lose it, and the music was then never given back when the window ended.
  // `overrideUntil` marks a window the operator has deliberately cancelled — see the control
  // handler. It holds that window's end time, so the next prayer pauses normally.
  ezan: { enabled: false, il: 'İstanbul', ilce: '', durationMinutes: 8, active: false, activePrayer: null, activeUntil: null, prevStatus: null, overrideUntil: null, times: {}, timesDate: null, lastError: null }
}

// One-level deep merge over defaults: a saved station.json that predates a newly-added
// nested field (e.g. queues.adCursor) must not drop back to `undefined` and crash a
// consumer like selectNextAd (state.ads[NaN]). Plain objects merge field-by-field;
// arrays (music, ads, history) and scalars replace wholesale, which is what we want.
function mergeState(saved) {
  const out = structuredClone(defaults)
  for (const [key, value] of Object.entries(saved || {})) {
    const base = out[key]
    if (value && typeof value === 'object' && !Array.isArray(value) &&
        base && typeof base === 'object' && !Array.isArray(base)) {
      out[key] = { ...base, ...value }
    } else {
      out[key] = value
    }
  }
  return out
}
// A café loses power. The station saves about once a second while it is playing, so sooner or
// later the mains go down in the middle of a write and `station.json` is left half-finished.
//
// Two files make that survivable. Every save is written to a temporary file and then renamed
// over the real one — a rename is atomic, so the station file is always either the whole old
// state or the whole new one, never half of either. The previous state is kept alongside it,
// so even a crash between the two renames leaves one complete copy on disk.
const backupPath = `${statePath}.yedek`
const tempPath = `${statePath}.yazi`

// What went wrong on the way in, so it can be logged once the history exists (this runs before
// `log()` is defined — the state it would write to is the very thing being loaded).
let recoveryNote = null

function tryRead(file) {
  try { return mergeState(JSON.parse(fs.readFileSync(file, 'utf8'))) } catch { return null }
}
// Damaged bytes are the only evidence of what actually happened. Renaming them out of the way
// preserves that and still frees the name; it must never be an overwrite.
function setAside(file) {
  try {
    if (!fs.existsSync(file) || !fs.statSync(file).size) return
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    fs.renameSync(file, path.join(root, `station.bozuk-${stamp}.json`))
  } catch (error) { console.error('Bozuk durum dosyası saklanamadı:', error.message) }
}
function readState() {
  const main = tryRead(statePath)
  if (main) return main
  // Nothing there at all is a first run, not an incident — say nothing.
  const hadFile = fs.existsSync(statePath)

  const backup = tryRead(backupPath)
  if (backup) {
    setAside(statePath)
    recoveryNote = 'Durum dosyası bozuktu, yedekten kurtarıldı'
    return backup
  }
  if (hadFile) {
    setAside(statePath)
    recoveryNote = 'Durum dosyası ve yedeği okunamadı, istasyon boş başlatıldı'
  }
  return structuredClone(defaults)
}
let state = readState()
// Migrate old installs: playback used to have one shared `volume`. Split it into
// independent musicVolume/adVolume, seeded from the old value so existing users
// don't get a surprise volume jump on first launch after the update.
if (state.playback.musicVolume == null || state.playback.adVolume == null) {
  const legacy = Number.isFinite(state.playback.volume) ? state.playback.volume : 76
  if (state.playback.musicVolume == null) state.playback.musicVolume = legacy
  if (state.playback.adVolume == null) state.playback.adVolume = legacy
}
let listeners = new Map()
let clients = new Set()

let saveTimer = null
function saveNow() {
  try {
    // Write somewhere harmless first and force it to the platter: without the fsync the
    // rename can land while the new file's contents are still only in the OS cache, which
    // is the same torn file with extra steps.
    const handle = fs.openSync(tempPath, 'w')
    try { fs.writeFileSync(handle, JSON.stringify(state, null, 2)); fs.fsyncSync(handle) } finally { fs.closeSync(handle) }
    // Keep the outgoing state as the backup before replacing it. If power fails between
    // these two renames the backup is a complete, if slightly stale, station.
    try { if (fs.existsSync(statePath)) fs.renameSync(statePath, backupPath) } catch {}
    fs.renameSync(tempPath, statePath)
  } catch (error) { console.error('Durum kaydedilemedi:', error.message) }
}
// Coalesce frequent saves (heartbeats, controls, ticks) into at most one disk
// write per second so a busy station never thrashes the event loop with I/O.
function save() { if (saveTimer) return; saveTimer = setTimeout(() => { saveTimer = null; saveNow() }, 1000); saveTimer.unref?.() }
// Enumerating the machine's adapters is far from free: measured at ~6 ms per call on a PC
// with the usual pile of virtual adapters. publicState() needs the list three times, and it
// is built on every broadcast — which runs on the SAME event loop that feeds the encoder its
// 20 ms audio chunks. Tens of milliseconds of blocking syscalls there is heard as a stutter.
//
// Addresses change when a cable is plugged or Wi-Fi reconnects, which is rare and never
// urgent: a few seconds of staleness costs nothing, and the panel refreshes on its own tick.
const LAN_IP_CACHE_MS = 5000
let lanIpsCache = { at: 0, list: [] }
function listLanIps() {
  if (Date.now() - lanIpsCache.at < LAN_IP_CACHE_MS) return lanIpsCache.list
  const out = []
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const item of addresses || []) {
      if (item.family !== 'IPv4' || item.internal) continue
      if (item.address.startsWith('169.254.')) continue // link-local (no DHCP)
      out.push({ name, ip: item.address })
    }
  }
  lanIpsCache = { at: Date.now(), list: out }
  return out
}
// Forces the next read to re-enumerate. Used where a stale answer would be actively wrong —
// refusing an address the operator just plugged in, or minting a certificate that misses it.
function refreshLanIps() {
  lanIpsCache = { at: 0, list: [] }
  return listLanIps()
}
// Score interfaces so we pick the real Wi-Fi/Ethernet LAN address the phones are
// on, not a VirtualBox/VMware/WSL/VPN adapter that phones can't reach.
function scoreIp({ name, ip }) {
  let score = 0
  if (ip.startsWith('192.168.')) score += 100
  else if (ip.startsWith('10.')) score += 80
  else if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) score += 60
  const n = name.toLowerCase()
  if (/(vmware|virtualbox|vethernet|hyper-v|hyperv|docker|loopback|bluetooth|vpn|tap-|tunnel|wsl|radmin|zerotier|hamachi|npcap)/.test(n)) score -= 60
  if (/(wi.?fi|wlan|wireless|kablosuz)/.test(n)) score += 25
  else if (/ethernet|eth/.test(n)) score += 18
  return score
}
function getLanIp() {
  const all = listLanIps()
  const preferred = state?.station?.preferredIp
  if (preferred && all.some(x => x.ip === preferred)) return preferred // operator's explicit choice
  if (!all.length) return '127.0.0.1'
  // Evidence beats guesswork. With two routers in the café both addresses are 192.168.x, so
  // the score falls through to the adapter NAME — and Wi-Fi (+25) outranks Ethernet (+18).
  // A PC wired to the router the phones are on therefore advertised the OTHER network, and
  // the QR opened nothing. If a phone has actually reached us on an address recently, that
  // address demonstrably works from where the customers are: prefer it over the heuristic.
  const proven = reachedViaList().map(r => r.ip).filter(ip => all.some(x => x.ip === ip))
  if (proven.length) {
    return proven.slice().sort((a, b) =>
      scoreIp(all.find(x => x.ip === b)) - scoreIp(all.find(x => x.ip === a)))[0]
  }
  return all.slice().sort((a, b) => scoreIp(b) - scoreIp(a))[0].ip
}
// ── Which address are phones actually reaching us on? ────────────────────────
// With more than one network (a café that added a second router) the operator has to guess
// which of the PC's addresses the phones can see, and a wrong guess looks exactly like a
// broken app: the QR opens nothing and nothing on screen explains why. The server does not
// have to guess — every request arrives on a specific local interface. Record that, and the
// panel can show which address is genuinely working instead of asking the operator to try
// combinations. Localhost is ignored: the desk PC talking to itself proves nothing.
const reachedVia = new Map()   // local interface ip → last time a phone arrived on it
const REACHED_TTL_MS = 10 * 60000
function noteReachedVia(req) {
  const remote = req.socket?.remoteAddress || ''
  if (!remote || remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1') return
  const local = String(req.socket?.localAddress || '').replace(/^::ffff:/, '')
  if (!local || local === '127.0.0.1') return
  reachedVia.set(local, Date.now())
}
function reachedViaList() {
  const cutoff = Date.now() - REACHED_TTL_MS
  for (const [ip, at] of reachedVia) if (at < cutoff) reachedVia.delete(ip)
  return [...reachedVia.entries()].map(([ip, at]) => ({ ip, lastAt: new Date(at).toISOString() }))
}
function cleanListeners() {
  const threshold = Date.now() - 45000
  for (const [id, touched] of listeners) if (touched < threshold) listeners.delete(id)
}
function currentPositionSeconds() {
  if (state.playback.status !== 'playing' || !state.playback.currentStartedAt) return Number(state.playback.currentOffsetSeconds || 0)
  return Math.max(0, Math.floor((Date.now() - new Date(state.playback.currentStartedAt).getTime()) / 1000))
}
function publicState() {
  cleanListeners()
  const current = state.playback.currentId
    ? [...state.music, ...state.ads].find(item => item.id === state.playback.currentId) || null
    : null
  const nextMusic = state.queues.music.slice(0, 10).map(id => state.music.find(item => item.id === id)).filter(Boolean)
  // `playedStack` is how the "previous" button steps back — purely internal, and nothing on
  // any client reads it. It was still being serialised and pushed to every phone on every
  // change: 50 entries of dead weight in a payload that goes out over the same Wi-Fi the
  // music is streaming on.
  const { playedStack, ...shared } = state
  return {
    ...shared,
    current,
    nextMusic,
    listeners: listeners.size,
    timing: { serverNow: Date.now(), mode: 'live-mp3', targetLatencySeconds: 2, livePositionSeconds: currentPositionSeconds() },
    network: (() => {
      const ip = getLanIp()
      const ips = listLanIps()
      const preferred = state.station.preferredIp || null
      return {
        ip, ips, preferred,
        preferredIp: preferred,
        // The saved address is gone (adapter unplugged, Wi-Fi dropped, router swapped). The
        // station keeps working on whatever address it does have, but the QR now points
        // somewhere else than the operator chose — which is exactly the situation where
        // phones "cannot connect" and nothing on screen says why.
        preferredMissing: !!preferred && !ips.some(x => x.ip === preferred),
        reachedVia: reachedViaList(),
        webUrl: `http://${ip}:${port}/listen`,
        adminUrl: `https://${ip}:${httpsPort}/listen`,
        streamUrl: `http://${ip}:${port}/live.mp3`
      }
    })(),
    capabilities: { streamingConfigured: true, message: 'Yerel MP3 yayın motoru aktif.' }
  }
}
// Fanning the state out is the expensive half of a state change: every open panel and phone
// receives the whole station (~13 KB measured with a 38-track library). A dragged volume
// slider produces several changes a second, so at 30 phones that is megabytes of duplicate
// state competing with the audio stream on the same café Wi-Fi. Send the first change
// immediately — the UI must feel instant — then collapse anything that follows within the
// window into ONE trailing send. The client that made the change never waits on this
// anyway: /api/control answers with the new state in its own response.
const BROADCAST_INTERVAL_MS = 200
// A phone that stops reading (asleep, out of range) would otherwise have state queued into
// its socket for ever. The audio hub already drops such clients; this is the same guard for
// the state channel, which had none.
const MAX_SSE_BACKLOG = 1024 * 1024
let broadcastTimer = null
let broadcastPending = false
function broadcast() {
  save()
  if (broadcastTimer) { broadcastPending = true; return }
  sendStateToClients()
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null
    if (broadcastPending) { broadcastPending = false; broadcast() }
  }, BROADCAST_INTERVAL_MS)
  broadcastTimer.unref?.()
}
function sendStateToClients() {
  const payload = `data: ${JSON.stringify(publicState())}\n\n`
  for (const response of clients) {
    if (response.writableEnded || response.destroyed) { clients.delete(response); continue }
    // Not keeping up: drop it rather than buffering without bound. The client's own
    // EventSource reconnects on its next network moment and gets a fresh full state.
    if (response.writableLength > MAX_SSE_BACKLOG) { try { response.destroy() } catch {} ; clients.delete(response); continue }
    try { response.write(payload) } catch { clients.delete(response) }
  }
}
function log(type, title) {
  state.history.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), type, title })
  state.history = state.history.slice(0, 100)
}
function buildMusicQueue() {
  const ids = state.music.map(item => item.id)
  if (state.playback.shuffle) {
    for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]] }
  }
  state.queues.music.push(...ids)
}
function itemById(id) { return id ? [...state.music, ...state.ads].find(track => track.id === id) || null : null }
function selectNextMusic() {
  if (!state.queues.music.length) buildMusicQueue()
  // Skip ids left over for tracks that were deleted, so a stale queue entry
  // can never make the engine try to play a file that no longer exists.
  const takePlayable = () => {
    while (state.queues.music.length) {
      const id = state.queues.music.shift()
      if (state.music.find(m => m.id === id)) return id
    }
    return null
  }
  const fromQueue = takePlayable()
  if (fromQueue) return fromQueue
  // Draining the queue found nothing playable — every id in it pointed at a file that has
  // since been removed (a saved queue from a previous session is the usual way this
  // happens). Reporting "no music" here left the station stopped with a folder full of
  // songs sitting right there, so rebuild from the CURRENT library and try once more.
  buildMusicQueue()
  return takePlayable()
}
function selectNextAd() {
  if (!state.ads.length) return null
  const index = state.queues.adCursor % state.ads.length
  state.queues.adCursor = (index + 1) % state.ads.length
  return state.ads[index].id
}
function timedAdDue() {
  return state.adSettings.timedEnabled && state.playback.nextTimedAdAt && Date.now() >= new Date(state.playback.nextTimedAdAt).getTime()
}
function resetTimedAd() {
  if (!state.adSettings.timedEnabled) { state.playback.nextTimedAdAt = null; return }
  // Clamp here as well as at the API boundary: this value can also arrive from a
  // station.json written by an older build, and an out-of-range one makes toISOString throw.
  const minutes = Math.max(1, Math.min(MAX_TIMED_MINUTES, Math.floor(Number(state.adSettings.timedMinutes)) || 60))
  state.playback.nextTimedAdAt = new Date(Date.now() + minutes * 60000).toISOString()
}
function setCurrent(id, type, pushHistory = true) {
  // Remember the outgoing track so the "previous" button can step back.
  if (pushHistory && state.playback.currentId && state.playback.currentId !== id) {
    if (!Array.isArray(state.playedStack)) state.playedStack = []
    state.playedStack.push({ id: state.playback.currentId, type: state.playback.currentType })
    if (state.playedStack.length > 50) state.playedStack.shift()
  }
  state.playback.currentId = id
  state.playback.currentType = type
  state.playback.status = id ? 'playing' : 'stopped'
  state.playback.currentStartedAt = id ? new Date().toISOString() : null
  state.playback.currentOffsetSeconds = 0
  const item = [...state.music, ...state.ads].find(track => track.id === id)
  if (item) log(type, `${type === 'ad' ? 'Reklam' : 'Müzik'}: ${item.title}`)
}
function advance({ manualAd = false } = {}) {
  // Never let the "every N songs" rule reach zero here, whatever is in the settings: the
  // counter resets to 0 after each ad, so `tracksSinceAd >= 0` would schedule another ad
  // immediately and the station would play ads back to back with no music, for ever.
  // Verified as a real loop before this guard existed.
  const songsEvery = Math.max(MIN_ADS_EVERY, Math.floor(Number(state.adSettings.songsEvery)) || MIN_ADS_EVERY)
  const automaticSongAd = state.adSettings.songsEnabled && state.playback.tracksSinceAd >= songsEvery
  const shouldPlayAd = manualAd || timedAdDue() || automaticSongAd
  if (shouldPlayAd) {
    const id = selectNextAd()
    if (id) {
      setCurrent(id, 'ad')
      state.playback.tracksSinceAd = 0
      resetTimedAd()
      return
    }
  }
  const id = selectNextMusic()
  if (id) setCurrent(id, 'music')
  else setCurrent(null, null)
}
function finishCurrent() {
  if (state.playback.currentType === 'music') state.playback.tracksSinceAd += 1
  advance()
}

let consecutiveFailures = 0
const audioEngine = new AudioEngine({
  mediaRoots,
  getState: () => state,
  onTrackEnded: () => { consecutiveFailures = 0; finishCurrent(); broadcast(); audioEngine.playCurrent() },
  onTrackFailed: () => {
    engineCounters.trackFailures += 1
    consecutiveFailures += 1
    const librarySize = state.music.length + state.ads.length
    if (consecutiveFailures > librarySize + 1) {
      // The whole library looks unplayable; stop instead of spinning through it.
      consecutiveFailures = 0
      state.playback.status = 'stopped'
      log('system', 'Çalınabilir parça bulunamadı, yayın durduruldu')
      broadcast()
      return
    }
    log('system', 'Parça çalınamadı, sonrakine geçildi')
    finishCurrent(); broadcast(); audioEngine.playCurrent()
  },
  onError: message => {
    if (!message) { broadcast(); return }
    engineCounters.engineErrors += 1
    // Count the two self-healing events separately: an encoder that keeps respawning, or a
    // stall that keeps recovering, is the signature of a station in trouble — and the whole
    // point of the status report is that nobody has to be standing at the PC to notice.
    const text = String(message)
    if (/kodlayıcı|encoder/i.test(text)) engineCounters.encoderRestarts += 1
    if (/durdu|stall/i.test(text)) engineCounters.stallRecoveries += 1
    log('system', 'FFmpeg ses motoru hatası')
    broadcast()
  }
})

// ── Admin authorization ──────────────────────────────────────────────────────
// Trust model: the operator's own machine (Electron / a localhost browser) is trusted
// and needs no code; untrusted phones on the café Wi-Fi must log in to mutate anything.
// Read-only endpoints (state, events, /live.mp3, heartbeat, QR) stay open so listeners
// just work.
//
// The code itself NEVER reaches the browser bundle. A phone POSTs the typed code to
// /api/admin/login and gets back a random session token; only that token travels on
// later requests. (The old build shipped the literal code inside the JS every phone
// downloads, so any customer could read it out of the page source and take over.)
const ADMIN_TOKEN_TTL = 12 * 60 * 60 * 1000
const adminCodePath = path.join(root, 'admin.json')
const adminTokens = new Map()   // token → expiry
let adminCode = ''
function loadAdminCode() {
  if (process.env.ADMIN_CODE) return String(process.env.ADMIN_CODE)
  try {
    const saved = JSON.parse(fs.readFileSync(adminCodePath, 'utf8'))
    if (saved && typeof saved.code === 'string' && saved.code) return saved.code
  } catch {}
  return rotateAdminCode()
}
// A fresh 6-digit code, easy to read off the desk screen and type on a phone. Stored
// outside station.json on purpose: station.json is broadcast to every listener.
function rotateAdminCode() {
  const code = String(crypto.randomInt(100000, 1000000))
  try { fs.writeFileSync(adminCodePath, JSON.stringify({ code }, null, 2)) } catch (error) { console.error('Yönetici kodu kaydedilemedi:', error.message) }
  adminCode = code
  adminTokens.clear()   // rotating the code logs every unlocked phone out
  return code
}
adminCode = loadAdminCode()
function issueAdminToken() {
  const token = crypto.randomBytes(24).toString('hex')
  adminTokens.set(token, Date.now() + ADMIN_TOKEN_TTL)
  return token
}
function validAdminToken(token) {
  const expiry = token ? adminTokens.get(token) : null
  if (!expiry) return false
  if (expiry < Date.now()) { adminTokens.delete(token); return false }
  return true
}
// Compare in constant time so the code can't be recovered one character at a time
// by measuring how long a wrong guess takes to be rejected.
function codeMatches(given) {
  const a = Buffer.from(String(given ?? ''))
  const b = Buffer.from(adminCode)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}
// A 6-digit code is only a million guesses; without a brake a script on the café
// Wi-Fi would walk the whole space in minutes. Five misses locks that IP out for a minute.
const LOGIN_WINDOW = 5 * 60000
const LOGIN_MAX = 5
const LOGIN_LOCK = 60000
const loginFailures = new Map()
function loginLocked(ip) { const r = loginFailures.get(ip); return !!(r && r.lockedUntil > Date.now()) }
function noteLoginFailure(ip) {
  const now = Date.now()
  const previous = loginFailures.get(ip)
  const record = previous && now - previous.first < LOGIN_WINDOW ? previous : { first: now, count: 0, lockedUntil: 0 }
  record.count += 1
  if (record.count >= LOGIN_MAX) { record.lockedUntil = now + LOGIN_LOCK; record.first = now; record.count = 0 }
  loginFailures.set(ip, record)
}
function isLocalRequest(req) {
  const addr = req.socket?.remoteAddress || ''
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}
function requireAdmin(req, res, next) {
  if (isLocalRequest(req)) return next()                        // the desk PC / Electron
  if (validAdminToken(req.get('x-admin-token'))) return next()   // phone that logged in
  return res.status(403).json({ error: 'Yetkisiz işlem: yönetici girişi gerekli' })
}
// Guards the few things only the café's own machine may see or do — reading the
// current admin code, and minting a new one.
function requireLocal(req, res, next) {
  if (isLocalRequest(req)) return next()
  res.status(403).json({ error: 'Bu işlem yalnızca kafe bilgisayarından yapılabilir' })
}

// Cross-site write guard. A malicious page open in a browser anywhere on this network
// can reach the station's address, so a write whose Origin isn't one of our own hosts is
// rejected. Requests with no Origin at all (Electron, curl) are left alone.
// The IP set is cached: /api/mic/chunk fires ~20×/s during an announcement and must not
// re-enumerate the network interfaces on every one.
let lanIpCache = { at: 0, ips: new Set() }
function lanIpSet() {
  if (Date.now() - lanIpCache.at > 15000) lanIpCache = { at: Date.now(), ips: new Set(listLanIps().map(x => x.ip)) }
  return lanIpCache.ips
}
function sameSiteWrites(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next()
  const origin = req.get('origin')
  if (!origin) return next()
  let host
  try { host = new URL(origin).hostname } catch { return res.status(403).json({ error: 'Geçersiz istek kaynağı' }) }
  // The real same-site test: did this page come from the SAME host the request is addressed
  // to? Matching only against our IPv4 list rejected every write from a phone that reached
  // the PC by name — `http://KAFE-PC:8090`, which Windows makes work on any LAN. The page
  // loaded and the audio played (those are GETs), but the listener count, the phone login
  // and the announcement all failed silently, which looks exactly like "the phone cannot
  // find us". Comparing against req.hostname covers every address form — IP, machine name,
  // mDNS, a domain later — and still refuses a genuinely foreign site.
  // Case-insensitive on purpose: `new URL()` lower-cases the hostname it parses, while the
  // Host header arrives exactly as the phone typed it — and Windows machine names are
  // normally capitalised (KAFE-PC). Comparing them raw failed for precisely the case this
  // check exists to allow.
  if (host === String(req.hostname || '').toLowerCase()) return next()
  if (host === '127.0.0.1' || host === 'localhost' || host === '::1' || lanIpSet().has(host)) return next()
  res.status(403).json({ error: 'Bu istek başka bir siteden geldi ve reddedildi' })
}

app.use(sameSiteWrites)
app.use(express.json({ limit: '2mb' }))
app.use(express.static(appRoot))
// The library files are NOT part of the listener experience — phones hear the station
// through /live.mp3, and nothing in the UI links to /media. Left open, these routes just
// let anyone on the café Wi-Fi enumerate and download the whole music collection.
app.use('/media/music', requireAdmin, express.static(mediaRoots.music))
app.use('/media/ad', requireAdmin, express.static(mediaRoots.ad))

const ALLOWED_AUDIO = /^audio\//i
const ALLOWED_AUDIO_EXT = /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus|weba|wma)$/i
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, callback) => callback(null, mediaRootFor(req.params.kind)),
    filename: (req, file, callback) => callback(null, `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9._ -]/g, '_')}`)
  }),
  // Only accept audio: block .exe/.bat/etc. from landing in the media folders, and cap
  // size to a sane value for a cafe. The EXTENSION is what decides whether the saved file
  // can later be opened as a program, so it must always be an audio one — the mimetype is
  // supplied by the uploading client and can simply claim "audio/mpeg" for an .exe, which
  // is why these two checks must both pass rather than either one.
  fileFilter: (req, file, callback) => {
    if (!ALLOWED_AUDIO_EXT.test(file.originalname)) return callback(new Error('Yalnızca ses dosyaları yüklenebilir'))
    if (file.mimetype && !ALLOWED_AUDIO.test(file.mimetype) && !/^application\/(octet-stream|ogg)$/i.test(file.mimetype)) {
      return callback(new Error('Yalnızca ses dosyaları yüklenebilir'))
    }
    callback(null, true)
  },
  limits: { fileSize: 100 * 1024 * 1024, files: 1 }
})

app.get('/live.mp3', (req, res) => { noteReachedVia(req); audioEngine.hub.attach(res) })
// The static file URL supports HTTP Range requests and is used by the
// personal player. Unlike a radio stream it can safely be seeked by a listener.
// (removed) /api/current-track — it served the "personal player" that no longer exists.
// Nothing in the UI called it, the /media URL it handed out is behind the admin guard now
// so the answer was unusable anyway, and it was unauthenticated: dead code on the public
// surface is only a liability. What is playing is already in /api/state.
app.get('/api/state', (req, res) => { noteReachedVia(req); res.json(publicState()) })
// A phone trades the typed code for a session token. The code is never sent back.
app.post('/api/admin/login', (req, res) => {
  const ip = req.socket?.remoteAddress || 'bilinmiyor'
  if (loginLocked(ip)) return res.status(429).json({ error: 'Çok fazla hatalı deneme. Bir dakika sonra tekrar deneyin.' })
  if (!codeMatches(req.body?.code)) { noteLoginFailure(ip); return res.status(403).json({ error: 'Kod yanlış' }) }
  loginFailures.delete(ip)
  log('system', 'Telefondan yönetici girişi yapıldı')
  broadcast()
  res.json({ token: issueAdminToken(), expiresInHours: ADMIN_TOKEN_TTL / 3600000 })
})
app.post('/api/admin/logout', (req, res) => { adminTokens.delete(req.get('x-admin-token')); res.sendStatus(204) })
// Shown on the desk PC's panel so the operator can read the code off their own screen.
app.get('/api/admin/code', requireLocal, (req, res) => res.json({ code: adminCode, fromEnv: !!process.env.ADMIN_CODE }))
// Lets the operator confirm the status report actually arrives, from the café PC, without
// waiting a day for the scheduled one. Local-only: it sends the station's data somewhere.
app.get('/api/report/status', requireLocal, (req, res) => {
  const cfg = readReportConfig()
  res.json({
    configured: !!cfg,
    url: cfg ? cfg.url : null,
    everyHours: cfg ? cfg.everyHours : null,
    lastSentAt: lastReportAt ? new Date(lastReportAt).toISOString() : null,
    failures: reportFailures,
    configPath: reportConfigPath
  })
})
app.post('/api/report/test', requireLocal, async (req, res) => {
  const result = await sendReport('test')
  res.status(result.sent ? 200 : 400).json(result)
})
// ── Uygulama içi güncelleme ──────────────────────────────────────────────────
// Readable by an admin (the operator may be looking at their phone), but INSTALLING is
// local-only: it shuts the station down and runs an installer, which is not something to
// trigger from across the room — or from a phone someone left unlocked on a table.
app.get('/api/update/status', requireAdmin, (req, res) => {
  if (!appUpdater) return res.json({ supported: false, version: APP_VERSION, reason: 'Bu kurulumda güncelleme kapalı' })
  res.json(appUpdater.status())
})
app.post('/api/update/check', requireAdmin, (req, res) => {
  if (!appUpdater) return res.status(400).json({ error: 'Bu kurulumda güncelleme kapalı' })
  appUpdater.check()
  res.json(appUpdater.status())
})
app.post('/api/update/install', requireLocal, (req, res) => {
  if (!appUpdater) return res.status(400).json({ error: 'Bu kurulumda güncelleme kapalı' })
  const status = appUpdater.status()
  // Refuse rather than half-apply: quitAndInstall with nothing downloaded closes the station
  // and installs nothing, which from the café's side is simply "the music stopped".
  if (!status.downloaded) return res.status(409).json({ error: 'Güncelleme henüz indirilmedi', status })
  const started = appUpdater.install()
  if (!started) return res.status(409).json({ error: 'Güncelleme başlatılamadı', status })
  log('system', `Güncelleme kuruluyor: ${status.newVersion || ''}`.trim())
  res.json({ installing: true, version: status.newVersion })
})
app.post('/api/admin/rotate', requireLocal, (req, res) => {
  if (process.env.ADMIN_CODE) return res.status(400).json({ error: 'Kod ADMIN_CODE ayarından geliyor, buradan değiştirilemez' })
  const code = rotateAdminCode()
  log('system', 'Yeni yönetici kodu üretildi')
  broadcast()
  res.json({ code })
})
app.get('/api/qr', async (req, res) => {
  try { res.json({ dataUrl: await QRCode.toDataURL(publicState().network.webUrl, { margin: 1, width: 220 }) }) }
  catch { res.status(500).json({ error: 'QR kod oluşturulamadı' }) }
})
app.get('/api/events', (req, res) => {
  // Each open stream is handed the full station state on every change. Uncapped, one
  // script opening connections in a loop grows memory and multiplies every broadcast.
  if (clients.size >= MAX_SSE_CLIENTS) return res.status(503).json({ error: 'Sunucu şu an çok yoğun' })
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
  res.flushHeaders()
  res.socket?.setTimeout?.(0)
  clients.add(res)
  res.write(`data: ${JSON.stringify(publicState())}\n\n`)
  // Remove the client on ANY termination (clean close, socket error, or a
  // half-open connection that never sends FIN) so the set cannot leak zombies.
  const drop = () => clients.delete(res)
  req.on('close', drop)
  res.on('error', drop)
  res.socket?.on('error', drop)
})
app.post('/api/listeners/heartbeat', (req, res) => {
  noteReachedVia(req)
  // Bounded id and bounded map: the id is attacker-chosen, so a loop of fresh ids would
  // otherwise grow this map (and the reported listener count) without limit.
  const id = String(req.body?.id || '').slice(0, 64)
  if (id && (listeners.has(id) || listeners.size < MAX_LISTENERS)) listeners.set(id, Date.now())
  // No broadcast here: this fires once per listener every 15s, and fanning a full state
  // dump out to every client on each beat made the cost grow with the square of the crowd.
  // The 15s tick already publishes the updated count.
  res.sendStatus(204)
})
app.post('/api/control', requireAdmin, (req, res) => {
  const { action, value } = req.body
  if (action === 'play') {
    if (!itemById(state.playback.currentId)) advance()   // no current, or it was deleted → pick a fresh track
    else {
      // Resume from the frozen position instead of jumping to the live edge.
      const position = Number(state.playback.currentOffsetSeconds || 0)
      state.playback.status = 'playing'
      state.playback.currentStartedAt = new Date(Date.now() - position * 1000).toISOString()
    }
  }
  if (action === 'pause') {
    // Freeze the exact position so resume continues from the same spot.
    state.playback.currentOffsetSeconds = currentPositionSeconds()
    state.playback.status = 'paused'
  }
  if (action === 'stop') {
    state.playback.status = 'stopped'
    state.playback.currentOffsetSeconds = 0
  }
  if (action === 'next') finishCurrent()
  if (action === 'previous') {
    const prev = Array.isArray(state.playedStack) ? state.playedStack.pop() : null
    if (prev && itemById(prev.id)) setCurrent(prev.id, prev.type, false)
    else log('system', 'Öncesinde parça yok')
  }
  // With no ads uploaded, advance({manualAd:true}) finds none and falls through to picking
  // MUSIC — so pressing "play an ad now" skipped the song that was playing. Do nothing and
  // say why instead of surprising the operator by changing the track.
  let manualAdSkipped = false
  if (action === 'manualAd') {
    if (!state.ads.length) { manualAdSkipped = true; log('system', 'Çalınacak reklam yok') }
    else { advance({ manualAd: true }); if (state.adSettings.manualResetsCounters) state.playback.tracksSinceAd = 0 }
  }
  if (action === 'playTrack' && value) {
    const inAds = state.ads.some(a => a.id === value)
    if (inAds || state.music.some(m => m.id === value)) setCurrent(value, inAds ? 'ad' : 'music')
  }
  // Broadcast levels go past 100: 100 is "the track at its normalised level", and the
  // operator sometimes needs the room to push louder than that. 200 doubles the samples
  // (+6 dB); the soft limiter in the mixer keeps the peaks from clipping.
  if (action === 'musicVolume') state.playback.musicVolume = Math.max(0, Math.min(MAX_VOLUME, Number(value) || 0))
  if (action === 'adVolume') state.playback.adVolume = Math.max(0, Math.min(MAX_VOLUME, Number(value) || 0))
  if (action === 'seek') {
    const current = [...state.music, ...state.ads].find(item => item.id === state.playback.currentId)
    const duration = Number(current?.durationSeconds || 0)
    // Bound the target even when the duration is unknown (a file whose length hasn't been
    // probed yet). Unbounded, a large value produced a date outside the range Date can
    // represent and toISOString() threw, leaving the stored position corrupted.
    const MAX_SEEK_SECONDS = 24 * 3600
    const position = Math.max(0, Math.min(duration || MAX_SEEK_SECONDS, Number(value) || 0))
    state.playback.currentOffsetSeconds = position
    state.playback.currentStartedAt = new Date(Date.now() - position * 1000).toISOString()
    log('system', `Yayın ${Math.floor(position)}. saniyeye alındı`)
  }
  if (action === 'microphoneStart') { state.microphone = { ...(state.microphone || {}), enabled: true }; if (value) audioEngine.micSampleRate = Math.max(8000, Math.min(96000, Number(value) || 48000)); log('microphone', 'Canlı mikrofon anonsu başlatıldı') }
  if (action === 'microphoneStop') { state.microphone = { ...(state.microphone || {}), enabled: false }; audioEngine.stopMic(); log('microphone', 'Canlı mikrofon anonsu sonlandırıldı') }
  // Pause/stop silence the broadcast; everything else (re)starts the encoder,
  // which now resumes at the true position instead of restarting the track.
  // microphoneStart/Stop drive the mic pipeline directly (startMic on first chunk).
  if (action === 'pause' || action === 'stop') audioEngine.stop()
  // musicVolume/adVolume are intentionally NOT here: levels are applied live in the
  // mixer (a per-sample multiply), so they take effect instantly with no decoder restart.
  // `manualAdSkipped` means nothing changed, so restarting the decoder would only cost the
  // listeners an audible re-buffer for a button press that did nothing.
  else if (!manualAdSkipped && ['play', 'next', 'previous', 'manualAd', 'playTrack', 'seek'].includes(action)) audioEngine.playCurrent()
  // Playback changed DURING a prayer window.
  //
  // Pausing/stopping: keep ezan's resume intent honest, or clearEzan would put music back
  // on that the operator had deliberately silenced.
  //
  // Starting audio (play, skip, picking a track): treat it as an explicit override. The
  // operator wants sound now — a private function, an empty café, a wrong prayer time in
  // the fetched schedule. Previously the audio started and the 20-second tick silently
  // paused it again, which reads as the app fighting the operator with no explanation.
  // The cancellation covers THIS window only; the next prayer pauses as normal.
  if (state.ezan.active) {
    if (action === 'pause' || action === 'stop') state.ezan.prevStatus = 'paused'
    else if (!manualAdSkipped && ['play', 'next', 'previous', 'playTrack', 'manualAd'].includes(action)) {
      state.ezan.overrideUntil = state.ezan.activeUntil
      state.ezan.active = false
      state.ezan.activePrayer = null
      state.ezan.activeUntil = null
      state.ezan.prevStatus = null
      log('system', 'Ezan duraklatması iptal edildi (operatör müziği başlattı)')
    }
  }
  broadcast()
  res.json(publicState())
})
// Live microphone: the admin browser captures raw PCM (s16le mono) and POSTs
// it here in small ordered chunks. The first chunk starts the mix; PCM is
// headerless so it survives track changes without desync.
app.post('/api/mic/chunk', requireAdmin, express.raw({ type: '*/*', limit: '2mb' }), (req, res) => {
  if (!state.microphone?.enabled) return res.sendStatus(409)
  const chunk = req.body
  if (chunk && chunk.length) {
    if (!audioEngine.micActive) audioEngine.startMic()
    audioEngine.writeMic(chunk)
  }
  res.sendStatus(204)
})
app.post('/api/mic/end', requireAdmin, (req, res) => { audioEngine.stopMic(); res.sendStatus(204) })
app.patch('/api/settings', requireAdmin, (req, res) => {
  const { station, playback, adSettings, microphone, ezan } = req.body
  // Everything below is accepted FIELD BY FIELD rather than spread in wholesale. The old
  // `{...state.x, ...body.x}` let a caller write any key at any value straight into the
  // state the engine runs on — including playback.status/currentId, and the ad-scheduling
  // numbers whose bad values are what caused the endless-ads loop.
  if (station) {
    if (typeof station.name === 'string' && station.name.trim()) state.station.name = station.name.trim().slice(0, 80)
    if ('preferredIp' in station) {
      // Only an address this machine actually has; anything else would publish a QR code and
      // stream URL that no phone can reach. SAY SO when it is refused: silently keeping the
      // old value made the selector look broken for an operator whose Wi-Fi had dropped
      // since the page was rendered — they pick the address they expect, nothing changes,
      // and nothing explains why.
      const wanted = station.preferredIp
      if (!wanted) state.station.preferredIp = null
      // Fresh read: the operator may be selecting an address that appeared seconds ago (they
      // just plugged the cable in), and refusing it because of a cached list would be exactly
      // the silent "the selector does nothing" failure this endpoint reports on.
      else if (refreshLanIps().some(x => x.ip === wanted)) state.station.preferredIp = wanted
      else {
        return res.status(400).json({
          error: `Bu bilgisayarda ${wanted} adresi şu anda yok. Ağ bağlantısı kopmuş olabilir — telefonlarla aynı ağa bağlanıp tekrar deneyin.`
        })
      }
    }
  }
  // Shuffle is the only playback field the UI edits through settings; transport and volume
  // go through /api/control, which validates them.
  if (playback && typeof playback.shuffle === 'boolean' && playback.shuffle !== state.playback.shuffle) {
    state.playback.shuffle = playback.shuffle
    // The queue was already built under the OLD setting and is drained one track at a time,
    // so flipping the flag alone changed nothing an operator could hear: with a full library
    // the next several hours still played in exactly the order they were queued in. The
    // switch has to rebuild what has not been played yet.
    //
    // Only the upcoming list is rebuilt — the track on air is held in playback.currentId and
    // is not part of the queue, so nothing jumps mid-song. It is also kept OUT of the fresh
    // queue, or the song still playing would be picked again immediately after itself.
    state.queues.music = []
    buildMusicQueue()
    state.queues.music = state.queues.music.filter(id => id !== state.playback.currentId)
    save()
  }
  if (adSettings) {
    if (typeof adSettings.songsEnabled === 'boolean') state.adSettings.songsEnabled = adSettings.songsEnabled
    if (typeof adSettings.timedEnabled === 'boolean') state.adSettings.timedEnabled = adSettings.timedEnabled
    if (typeof adSettings.manualResetsCounters === 'boolean') state.adSettings.manualResetsCounters = adSettings.manualResetsCounters
    // A cleared number field sends 0. Ignore values below the minimum instead of storing
    // them: silently rounding 0 up to 1 would also be defensible, but keeping the previous
    // setting means an operator mid-edit never gets a schedule they did not choose.
    if (adSettings.songsEvery != null) {
      const every = Math.floor(Number(adSettings.songsEvery))
      if (Number.isFinite(every) && every >= MIN_ADS_EVERY) state.adSettings.songsEvery = Math.min(MAX_ADS_EVERY, every)
    }
    if (adSettings.timedMinutes != null) {
      const minutes = Math.floor(Number(adSettings.timedMinutes))
      if (Number.isFinite(minutes) && minutes >= 1) state.adSettings.timedMinutes = Math.min(MAX_TIMED_MINUTES, minutes)
    }
    resetTimedAd()
  }
  if (microphone && microphone.ducking != null) {
    const ducking = Number(microphone.ducking)
    if (Number.isFinite(ducking)) state.microphone.ducking = Math.max(0, Math.min(100, ducking))
  }
  if (ezan) {
    // Only accept the user-editable fields; the rest are driven by the server.
    if (typeof ezan.enabled === 'boolean') state.ezan.enabled = ezan.enabled
    let locChanged = false
    if (typeof ezan.il === 'string' && ezan.il.trim() && ezan.il.trim() !== state.ezan.il) { state.ezan.il = ezan.il.trim(); locChanged = true }
    if (typeof ezan.ilce === 'string' && ezan.ilce.trim() !== (state.ezan.ilce || '')) { state.ezan.ilce = ezan.ilce.trim(); locChanged = true }
    // An operator changing the city, or switching the feature on, is an explicit "try now":
    // clear the backoff so they are not left waiting out a retry window they cannot see.
    if (locChanged || ezan.enabled === true) { ezanFailures = 0; ezanRetryAt = 0 }
    if (locChanged) { state.ezan.times = {}; state.ezan.timesDate = null; state.ezan.lastError = null }
    if (ezan.durationMinutes != null) state.ezan.durationMinutes = Math.max(1, Math.min(60, Number(ezan.durationMinutes) || 8))
    ezanTick().catch(() => {}) // re-evaluate (fetch new times / activate / clear) right away
  }
  // No decoder restart on settings changes: the ducking level is read live per-sample
  // in the mixer (buildChunk), so moving the "music under mic" slider takes effect
  // instantly. Restarting playCurrent() here used to stop+reseek the decoder mid-
  // announcement, which the operator heard as a music glitch on every slider move.
  broadcast(); res.json(publicState())
})
function probeDuration(filePath) {
  return new Promise(resolve => {
    let output = ''
    let done = false
    const finish = value => { if (done) return; done = true; clearTimeout(timer); try { child.kill() } catch {}; resolve(value) }
    const child = spawn(ffmpegPath, ['-hide_banner', '-i', filePath], { windowsHide: true })
    // Cap stderr accumulation so a file that makes ffmpeg spew endless diagnostics
    // can't grow this string without bound.
    child.stderr.on('data', chunk => { if (output.length < 65536) output += chunk.toString() })
    child.on('error', () => finish(null))
    child.on('close', () => {
      const match = output.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
      finish(match ? Math.round(Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) : null)
    })
    // Never let a hung/stalled ffmpeg (corrupt file, unavailable network share)
    // orphan the process or block the upload response forever.
    const timer = setTimeout(() => finish(null), 15000)
    timer.unref?.()
  })
}

// ── Loudness normalisation ───────────────────────────────────────────────────
// Files come from wildly different sources: the music library spans -19 to -6.5 LUFS
// and the phone-recorded announcements go down to -27.9 LUFS. That is a ~21 dB spread,
// so one track is inaudible where the next is jarring, and no single volume slider can
// fix it — the slider moves a whole category at once. Instead we measure each file's
// real loudness ONCE and store a per-track gain, the same thing Spotify/YouTube do.
const TARGET_LUFS = -14
// Announcements are quiet on average but have sharp transient peaks, so the gain that
// would keep every peak below full scale is far smaller than the gain they actually
// need (e.g. +6.3 dB of peak room against +13.9 dB needed). We allow a bounded amount
// of extra gain past that point and let the soft limiter in the mixer absorb the rare
// peaks — audibly far better than leaving the announcement 7 dB too quiet.
const LIMITER_HEADROOM_DB = 6
const MAX_GAIN_DB = 12
const MIN_GAIN_DB = -20
function probeLoudness(filePath) {
  return new Promise(resolve => {
    let output = ''
    let done = false
    const finish = value => { if (done) return; done = true; clearTimeout(timer); try { child.kill() } catch {}; resolve(value) }
    const child = spawn(ffmpegPath, ['-hide_banner', '-i', filePath, '-af', 'ebur128=peak=true', '-f', 'null', '-'], { windowsHide: true })
    // ebur128 logs a progress line every ~100ms, so a 5-minute track emits several
    // hundred KB before the Summary block that we actually want. Keep a rolling TAIL
    // rather than a capped head: capping the head threw the summary away entirely and
    // silently left every long file un-normalised while short ones worked.
    child.stderr.on('data', chunk => {
      output += chunk.toString()
      if (output.length > 65536) output = output.slice(-65536)
    })
    child.on('error', () => finish(null))
    child.on('close', () => {
      // ebur128 prints a Summary block at the end; the integrated loudness and the true
      // peak both live there. Read the LAST occurrence so per-frame lines can't win.
      const summary = output.slice(output.lastIndexOf('Summary:'))
      const loudness = summary.match(/I:\s*(-?[\d.]+)\s*LUFS/)
      const peak = summary.match(/Peak:\s*(-?[\d.]+)\s*dBFS/)
      if (!loudness) return finish(null)
      finish(gainForTrack(Number(loudness[1]), peak ? Number(peak[1]) : null))
    })
    // Analysis decodes the whole file (~1s for a typical track); the same generous
    // ceiling probeDuration uses covers a stalled read on a bad file.
    const timer = setTimeout(() => finish(null), 15000)
    timer.unref?.()
  })
}
function gainForTrack(integratedLufs, truePeakDb) {
  if (!Number.isFinite(integratedLufs)) return null
  const wanted = TARGET_LUFS - integratedLufs
  // Turning a track DOWN can never clip, so the peak ceiling only constrains boosts.
  const peakRoom = Number.isFinite(truePeakDb) ? Math.max(-truePeakDb - 1, 0) + LIMITER_HEADROOM_DB : MAX_GAIN_DB
  const gain = Math.min(wanted, peakRoom, MAX_GAIN_DB)
  return Number(Math.max(gain, MIN_GAIN_DB).toFixed(2))
}

app.post('/api/media/:kind', requireAdmin, (req, res, next) => {
  if (!mediaRootFor(req.params.kind)) return res.status(404).json({ error: 'Geçersiz medya türü' })
  next()
}, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Dosya bulunamadı' })
  const kind = req.params.kind
  const title = path.parse(req.file.originalname).name
  const item = { id: crypto.randomUUID(), title, artist: 'Bilinmeyen sanatçı', filename: req.file.filename, durationSeconds: await probeDuration(req.file.path), gainDb: await probeLoudness(req.file.path) ?? 0, addedAt: new Date().toISOString() }
  // The file is on disk before the two ffmpeg probes above run, so a folder scan during
  // that second or two sees it, finds no library entry, and adds one of its own — then this
  // handler added a SECOND entry for the same file. Both survive pruning (the file exists),
  // so the track stayed listed twice for good and deleting one left the other pointing at a
  // file that was gone. Reproduced on the first attempt, so: adopt the scan's entry instead.
  const list = kind === 'ad' ? state.ads : state.music
  const existing = list.find(entry => entry.filename === req.file.filename)
  if (existing) {
    existing.title = title
    existing.durationSeconds = item.durationSeconds ?? existing.durationSeconds
    existing.gainDb = item.gainDb ?? existing.gainDb
  } else {
    list.push(item)
  }
  log('system', `${kind === 'ad' ? 'Reklam' : 'Müzik'} eklendi: ${title}`)
  broadcast(); res.status(201).json(existing || item)
})
// Open the media folder in the OS file manager so the operator can drop files in
// directly. The library auto-scans these folders, so dropped files appear on their own.
app.post('/api/open-folder/:kind', requireAdmin, (req, res) => {
  const dir = mediaRootFor(req.params.kind)
  if (!dir) return res.status(404).json({ error: 'Geçersiz klasör' })
  try { spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref() } catch {}
  res.sendStatus(204)
})
// Force an immediate folder scan (e.g. after dropping files) instead of waiting
// for the periodic 15s scan.
app.post('/api/rescan', requireAdmin, async (req, res) => {
  // A pass already in flight listed the folder BEFORE the operator dropped their files, so
  // joining it would answer with a library that still lacks exactly what "Yenile" was
  // pressed for. Wait for it to finish, then run a fresh pass of our own.
  if (scanning) await scanning
  await scanLibrary()
  res.json(publicState())
})
app.delete('/api/media/:kind/:id', requireAdmin, (req, res) => {
  const dir = mediaRootFor(req.params.kind)
  const key = KIND_KEY[req.params.kind]
  if (!dir || !key) return res.status(404).json({ error: 'Geçersiz medya türü' })
  const index = state[key].findIndex(item => item.id === req.params.id)
  if (index < 0) return res.sendStatus(404)
  const [item] = state[key].splice(index, 1)
  try { fs.unlinkSync(path.join(dir, item.filename)) } catch {}
  // Purge any stale queue entry for this track.
  state.queues.music = state.queues.music.filter(qid => qid !== req.params.id)
  // If the track being removed is the one on air, move on cleanly instead of
  // leaving a dangling currentId that silently plays nothing.
  if (state.playback.currentId === req.params.id) {
    if (state.playback.status === 'playing') { advance(); audioEngine.playCurrent() }
    else { setCurrent(null, null); audioEngine.stop() }
  }
  broadcast(); res.sendStatus(204)
})
app.get('*splat', (req, res) => {
  // Never cache the shell HTML, so phones always load the latest hashed bundle
  // after an update (the assets themselves are content-hashed and cache freely).
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate')
  if (fs.existsSync(appRoot)) return res.sendFile(path.join(appRoot, 'index.html'))
  res.status(404).send('Rovli Radyo arayüzü henüz derlenmedi. Geliştirme için npm run dev kullanın.')
})
// Turn upload/multer errors (rejected type, too large) and any unhandled route
// error into a clean JSON response instead of a raw HTML 500.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err)
  const tooBig = err?.code === 'LIMIT_FILE_SIZE'
  res.status(tooBig ? 413 : 400).json({ error: err?.message || 'İstek işlenemedi' })
})

// Folder-based library: the Music/Ads folders ARE the library. Files dropped in
// (via the app upload or straight into the folder) are picked up automatically,
// and entries whose file was removed from the folder are pruned.
// Holds the in-flight scan's promise (null when idle) rather than a bare boolean, so a
// caller can WAIT for a pass that is already running instead of silently getting nothing.
let scanning = null
function scanLibrary() {
  if (scanning) return scanning
  scanning = runScan().finally(() => { scanning = null })
  return scanning
}
async function runScan() {
  let changed = false
  // Shared across both folders so a pass never analyses more than this many files total.
  let loudnessBudget = LOUDNESS_PER_SCAN
  try {
    for (const [kind, key] of Object.entries(KIND_KEY)) {
      const dir = mediaRoots[kind]
      let files = []
      try { files = fs.readdirSync(dir).filter(f => SCAN_AUDIO_RE.test(f)) } catch { continue }
      const present = new Set(files)
      for (const filename of files) {
        if (state[key].some(item => item.filename === filename)) continue
        const item = { id: crypto.randomUUID(), title: path.parse(filename).name, artist: 'Bilinmeyen sanatçı', filename, durationSeconds: await probeDuration(path.join(dir, filename)), addedAt: new Date().toISOString() }
        // Re-check after the await. Probing yields for a second or so, and an upload of this
        // very file can land its own entry in that gap — the check above was made against a
        // library that no longer exists. Skipping here is what keeps the track from being
        // listed twice for good (both copies point at a real file, so pruning keeps both).
        if (state[key].some(entry => entry.filename === filename)) continue
        state[key].push(item)
        changed = true
      }
      // Fill in durations that are still missing — but GIVE UP on a file that keeps failing.
      // Retrying forever meant a single unreadable file spawned an ffmpeg every 15 seconds
      // for the life of the station (each with a 15-second ceiling of its own) and marked the
      // library as changed every time, fanning a full state broadcast out to every phone.
      // A file that cannot be read three times running is not going to start working.
      for (const item of state[key]) {
        if (item.durationSeconds) continue
        if ((item.probeFailures || 0) >= MAX_PROBE_ATTEMPTS) continue
        const filePath = path.join(dir, item.filename)
        if (!fs.existsSync(filePath)) continue
        const duration = await probeDuration(filePath)
        if (duration) {
          item.durationSeconds = duration
          delete item.probeFailures
          changed = true
        } else {
          item.probeFailures = (item.probeFailures || 0) + 1
          changed = true
          // Say it once, when we stop trying. Until now a broken file was simply a track that
          // never played, with nothing anywhere explaining why.
          if (item.probeFailures >= MAX_PROBE_ATTEMPTS) {
            log('system', `Dosya okunamıyor, atlanacak: ${item.title}`)
          }
        }
      }
      // Loudness analysis decodes the whole file, so it is deliberately rationed: a few
      // tracks per pass, and only after durations are filled in (playback order depends
      // on duration, nothing depends on gain). A track with no gain yet simply plays at
      // its original level until its turn comes.
      for (const item of state[key]) {
        if (loudnessBudget <= 0) break
        if (item.gainDb != null || !item.durationSeconds) continue
        const filePath = path.join(dir, item.filename)
        if (!fs.existsSync(filePath)) continue
        loudnessBudget -= 1
        const gain = await probeLoudness(filePath)
        // Store 0 rather than leaving it unset when analysis fails, so a file ffmpeg
        // cannot measure isn't retried on every single scan for the life of the station.
        item.gainDb = gain == null ? 0 : gain
        changed = true
      }
      const before = state[key].length
      state[key] = state[key].filter(item => present.has(item.filename))
      if (state[key].length !== before) changed = true
    }
    if (changed) {
      state.queues.music = state.queues.music.filter(id => state.music.some(m => m.id === id))
      broadcast()
    }
    // Catch-all for "supposed to be playing, but nothing actually is". Several routes lead
    // here — a saved track deleted while the app was closed, a queue left holding only
    // removed ids, or music dropped into an empty folder after launch — and in every one of
    // them the station used to latch silent while reporting "playing", with nothing ever
    // re-evaluating it. The scan already runs every 15s and knows what the library holds,
    // so it is the natural place to notice and start the music.
    if (state.playback.status === 'playing' && !itemById(state.playback.currentId) && state.music.length) {
      advance()
      audioEngine.playCurrent()
      broadcast()
    }
  } catch (error) {
    // A scan that throws (an unreadable folder, a disconnected network drive) must not
    // reject into its callers — /api/rescan would answer 500 and the 15s tick would log an
    // unhandled rejection. Report it and let the next pass try again.
    console.error('Kütüphane taraması başarısız:', error?.message)
  }
}
// ── Durum raporu (uzaktan izleme) ────────────────────────────────────────────
// The café PC is somewhere else, on a network nobody here can reach, running other business
// software that must not be disturbed — so no VPN, no inbound port, no agent. The station
// instead POSTS a small status report OUTWARD, which needs nothing from the network but the
// internet connection it already has.
//
// Off unless configured, and configured OUTSIDE the installer: the destination lives in
// report.json in the data folder, so no exe ever carries a URL or a token. A café that never
// creates the file never sends anything.
//
// What goes in is deliberately operational only — versions, counters, network addresses,
// recent station events. Never the admin code, never a session token, never anything about a
// customer. This leaves the building, so it stays boring on purpose.
const reportConfigPath = path.join(root, 'report.json')
const REPORT_RETRY_WAITS_MS = [5 * 60000, 15 * 60000, 60 * 60000]
let reportFailures = 0
let reportRetryAt = 0
let lastReportAt = 0
const startedAt = Date.now()
// Counters the report carries: how often the engine had to save itself. A café that never
// looks at its PC still gets to find out its encoder is restarting twice an hour.
const engineCounters = { encoderRestarts: 0, trackFailures: 0, stallRecoveries: 0, engineErrors: 0 }
function readReportConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(reportConfigPath, 'utf8'))
    if (!cfg || cfg.enabled === false || typeof cfg.url !== 'string' || !/^https?:\/\//i.test(cfg.url)) return null
    return {
      url: cfg.url,
      label: typeof cfg.label === 'string' ? cfg.label.slice(0, 60) : '',
      everyHours: Math.max(1, Math.min(168, Number(cfg.everyHours) || 24)),
      token: typeof cfg.token === 'string' ? cfg.token : ''   // optional shared secret for the receiver
    }
  } catch { return null }
}
function buildReport(reason) {
  const current = itemById(state.playback.currentId)
  return {
    sentAt: new Date().toISOString(),
    reason,
    app: { version: APP_VERSION, uptimeMinutes: Math.round((Date.now() - startedAt) / 60000) },
    station: { name: state.station?.name || '', label: readReportConfig()?.label || '' },
    playback: {
      status: state.playback.status,
      current: current ? current.title : null,
      musicVolume: state.playback.musicVolume,
      adVolume: state.playback.adVolume
    },
    library: { music: state.music.length, ads: state.ads.length },
    listeners: listeners.size,
    // The field that answers "why can't the phones connect": every address this machine has,
    // which one the QR advertises, and which ones phones have actually arrived on.
    network: {
      ip: getLanIp(),
      addresses: listLanIps(),
      preferredIp: state.station.preferredIp || null,
      preferredMissing: !!state.station.preferredIp && !listLanIps().some(x => x.ip === state.station.preferredIp),
      reachedVia: reachedViaList()
    },
    engine: { ...engineCounters },
    ezan: { enabled: !!state.ezan.enabled, timesDate: state.ezan.timesDate, lastError: state.ezan.lastError },
    recent: (state.history || []).slice(0, 25).map(h => ({ at: h.at, type: h.type, title: h.title }))
  }
}
async function sendReport(reason) {
  const cfg = readReportConfig()
  if (!cfg) return { sent: false, reason: 'yapılandırılmamış' }
  if (reason !== 'test' && Date.now() < reportRetryAt) return { sent: false, reason: 'bekleniyor' }
  try {
    const response = await fetch(cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cfg.token ? { 'x-report-token': cfg.token } : {}) },
      body: JSON.stringify(buildReport(reason)),
      signal: AbortSignal.timeout(15000)
    })
    if (!response.ok) throw new Error('HTTP ' + response.status)
    reportFailures = 0
    reportRetryAt = 0
    lastReportAt = Date.now()
    return { sent: true }
  } catch (error) {
    // A station must never be affected by its own telemetry: back off and carry on. The
    // café's music does not stop because a log could not be delivered.
    reportFailures += 1
    reportRetryAt = Date.now() + REPORT_RETRY_WAITS_MS[Math.min(reportFailures - 1, REPORT_RETRY_WAITS_MS.length - 1)]
    return { sent: false, reason: error.message }
  }
}
function maybeSendScheduledReport() {
  const cfg = readReportConfig()
  if (!cfg) return
  if (Date.now() - lastReportAt < cfg.everyHours * 3600000) return
  sendReport(lastReportAt ? 'periyodik' : 'başlangıç').catch(() => {})
}

// Expired sessions and stale lockout records would otherwise sit in memory for the whole
// run of a station that stays up for weeks.
function sweepAuth() {
  const now = Date.now()
  for (const [token, expiry] of adminTokens) if (expiry < now) adminTokens.delete(token)
  for (const [ip, record] of loginFailures) {
    if (record.lockedUntil < now && now - record.first > LOGIN_WINDOW) loginFailures.delete(ip)
  }
}
const tickTimer = setInterval(() => { cleanListeners(); sweepAuth(); maybeSendScheduledReport(); broadcast(); scanLibrary().catch(() => {}) }, 15000)
tickTimer.unref()
resetTimedAd()
// Recovery happened before `log()` existed — the history it writes to is what was being
// loaded. Report it now, so a power cut leaves a trace the operator can actually find
// instead of a station that quietly looks freshly installed.
if (recoveryNote) { log('system', recoveryNote); recoveryNote = null }
scanLibrary().catch(() => {})
// Catch-all cleanup: kill ffmpeg and flush state on ANY exit (incl. Electron
// quit, which may not raise SIGTERM), so no orphaned ffmpeg.exe is left behind.
// shutdown(), not stop(): stop() only ends the per-track decoder, so the PERSISTENT encoder
// was left to notice its pipes had closed and exit on its own. It does, but only once the
// parent is gone — killing it here is immediate and is what this handler always claimed to do.
process.on('exit', () => { try { audioEngine.shutdown() } catch {} try { saveNow() } catch {} })
// Resume the broadcast on boot (e.g. after an Electron restart) so a station
// that was playing does not sit silent until an operator touches a control.
if (state.playback.status === 'playing' && state.playback.currentId) {
  // The saved track may be gone — deleted from the folder while the app was closed. Left
  // as-is the engine finds no file, plays nothing, and the station sits SILENT while the
  // UI cheerfully reports "playing", which is the one failure an operator cannot diagnose.
  // Pick a fresh track instead of trying to resume a file that no longer exists — but only
  // once the library is actually loaded. Calling advance() against a library that is still
  // being scanned finds nothing, and setCurrent(null) would flip the status to "stopped",
  // destroying the very intent the scan hook below relies on to start the music.
  if (!itemById(state.playback.currentId) && state.music.length) advance()
  state.playback.currentStartedAt = new Date().toISOString()
  state.playback.currentOffsetSeconds = 0
  audioEngine.playCurrent()
}

// ---- Ezan (call to prayer) auto-pause: Diyanet times via Aladhan method=13 ----
const PRAYER_MAP = [['Sabah', 'Fajr'], ['Öğle', 'Dhuhr'], ['İkindi', 'Asr'], ['Akşam', 'Maghrib'], ['Yatsı', 'Isha']]
let ezanFetching = false
// Retry backoff for the prayer-times API. A café with no internet used to re-request every
// 20 seconds for ever — thousands of failed calls a day against a public service, which is
// the sort of thing that gets an address blocked, and then the feature stays broken even
// after the connection comes back. Wait longer after each failure, reset on success.
const EZAN_RETRY_WAITS_MS = [60_000, 120_000, 300_000, 900_000, 1_800_000]
let ezanFailures = 0
let ezanRetryAt = 0
// Overridable so the retry behaviour can be tested without depending on a live service.
const EZAN_API_URL = process.env.EZAN_API_URL || 'https://api.aladhan.com/v1/timingsByAddress'
function todayStr() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
async function fetchPrayerTimes() {
  const il = String(state.ezan.il || 'İstanbul').trim() || 'İstanbul'
  const ilce = String(state.ezan.ilce || '').trim()
  const address = `${ilce ? ilce + ', ' : ''}${il}, Türkiye`
  const url = `${EZAN_API_URL}?address=${encodeURIComponent(address)}&method=13`
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  const timings = (await res.json())?.data?.timings
  const times = {}
  for (const [tr, en] of PRAYER_MAP) { const m = String(timings?.[en] || '').match(/(\d{1,2}):(\d{2})/); if (m) times[tr] = `${m[1].padStart(2, '0')}:${m[2]}` }
  if (!Object.keys(times).length) throw new Error('Vakitler boş döndü')
  state.ezan.times = times
  state.ezan.timesDate = todayStr()
  state.ezan.lastError = null
}
function setEzanActive(prayer, until) {
  state.ezan.active = true
  state.ezan.activePrayer = prayer
  state.ezan.activeUntil = until
  state.ezan.prevStatus = state.playback.status
  if (state.playback.status === 'playing') {
    state.playback.currentOffsetSeconds = currentPositionSeconds()
    state.playback.status = 'paused'
    audioEngine.stop()
  }
  log('system', `Ezan vakti (${prayer}) — müzik duraklatıldı`)
  broadcast()
}
function clearEzan() {
  // A missing value means the app restarted inside the prayer window (the old module-level
  // variable did not survive that) or the saved state predates this field. Resume in that
  // case: an ezan pause that never gives the music back leaves the café silent for the rest
  // of the day, and nothing in the UI explains why.
  const prev = state.ezan.prevStatus
  const resume = prev == null ? true : prev === 'playing'
  state.ezan.active = false
  state.ezan.activePrayer = null
  state.ezan.activeUntil = null
  state.ezan.prevStatus = null
  if (resume && state.playback.currentId) {
    const pos = Number(state.playback.currentOffsetSeconds || 0)
    state.playback.status = 'playing'
    state.playback.currentStartedAt = new Date(Date.now() - pos * 1000).toISOString()
    audioEngine.playCurrent()
  }
  log('system', 'Ezan vakti bitti — müzik devam ediyor')
  broadcast()
}
async function ezanTick() {
  const ez = state.ezan
  if (!ez.enabled) { if (ez.active) clearEzan(); return }
  if (ez.timesDate !== todayStr() || !Object.keys(ez.times || {}).length) {
    if (!ezanFetching && Date.now() >= ezanRetryAt) {
      ezanFetching = true
      try {
        await fetchPrayerTimes()
        ezanFailures = 0
        ezanRetryAt = 0
        broadcast()
      } catch (error) {
        ezanFailures += 1
        ezanRetryAt = Date.now() + EZAN_RETRY_WAITS_MS[Math.min(ezanFailures - 1, EZAN_RETRY_WAITS_MS.length - 1)]
        ez.lastError = error.message
        broadcast()
      } finally { ezanFetching = false }
    }
    if (!Object.keys(ez.times || {}).length) return
  }
  const now = new Date()
  const nowMin = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60
  const dur = Math.max(1, Math.min(60, Number(ez.durationMinutes || 8)))
  // The window arithmetic lives in its own module so its edge cases — a window running past
  // midnight, a malformed time in the fetched schedule — can be tested against an injected
  // clock instead of whatever time the test happens to run at.
  const active = findActiveWindow(ez.times, dur, now)
  const hit = active
    ? { prayer: active.prayer, until: new Date(now.getTime() + active.minutesLeft * 60000).toISOString() }
    : null
  // A window the operator cancelled must not be re-armed by the next tick — that was the
  // whole point of the override. `overrideUntil` holds that window's end, so the guard
  // lapses on its own and the following prayer behaves normally.
  const overridden = ez.overrideUntil && Date.now() < new Date(ez.overrideUntil).getTime()
  if (!hit && ez.overrideUntil) ez.overrideUntil = null   // window is over; forget the override
  if (hit && !ez.active && !overridden) setEzanActive(hit.prayer, hit.until)
  else if (!hit && ez.active) clearEzan()
  else if (hit && ez.active) {
    ez.activeUntil = hit.until
    // Re-assert the pause if music somehow resumed during the ezan window.
    if (state.playback.status === 'playing') {
      state.playback.currentOffsetSeconds = currentPositionSeconds()
      state.playback.status = 'paused'
      audioEngine.stop()
      broadcast()
    }
  }
}
const ezanTimer = setInterval(() => { ezanTick().catch(() => {}) }, 20000)
ezanTimer.unref()
ezanTick().catch(() => {})

// Mint this install's own HTTPS certificate on first run. Generating it here (rather than
// shipping one in the installer) means the private key exists only on this machine.
// A certificate only covers the addresses it was minted for. Swap the café's router and the
// PC lands on a new subnet — the old certificate now names an address the machine no longer
// has, so the phone gets a NAME MISMATCH on top of the self-signed warning. Some mobile
// browsers refuse to let anyone past that at all, and the announcement page (which needs
// HTTPS for the microphone) simply stops opening. Detect it and mint a new one.
function certCoversCurrentIps(certPem) {
  try {
    const { X509Certificate } = require('crypto')
    const san = new X509Certificate(certPem).subjectAltName || ''
    const ips = listLanIps().map(x => x.ip)
    if (!ips.length) return true   // nothing to cover yet; don't churn the certificate
    return ips.every(ip => san.includes(ip))
  } catch { return true }   // unreadable: leave it alone rather than regenerating in a loop
}
async function ensureCerts() {
  const keyPath = path.join(certDir, 'key.pem')
  const certPath = path.join(certDir, 'cert.pem')
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    const cert = fs.readFileSync(certPath)
    if (certCoversCurrentIps(cert)) return { key: fs.readFileSync(keyPath), cert }
    console.log('Ağ adresi değişmiş — HTTPS sertifikası yeni adrese göre yenileniyor.')
  }
  const altNames = [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }]
  // Fresh read: a certificate is minted once and lived with for years, so it must name the
  // addresses the machine has right now, not a list cached moments earlier.
  for (const { ip } of refreshLanIps()) altNames.push({ type: 7, ip })
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'Rovli Radyo' }], {
    keySize: 2048,
    algorithm: 'sha256',
    notAfterDate: new Date(Date.now() + 10 * 365 * 24 * 3600 * 1000),
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames }
    ]
  })
  fs.writeFileSync(keyPath, pems.private)
  fs.writeFileSync(certPath, pems.cert)
  // Owner-only where the filesystem enforces it; a no-op on plain Windows volumes.
  try { fs.chmodSync(keyPath, 0o600) } catch {}
  console.log('Bu kuruluma özel HTTPS sertifikası üretildi.')
  return { key: pems.private, cert: pems.cert }
}

// `updater` is supplied by electron/main.cjs when the station runs as the desktop app. Running
// from source (npm start) there is nothing to update, so it is absent and the endpoints below
// report that honestly instead of pretending.
function startServer({ updater } = {}) {
  appUpdater = updater || null
  // `exclusive: true` matters on Windows. Without it two processes can BOTH bind this port —
  // the second one even logs that it started — and incoming connections are then handed to
  // one of them unpredictably. Two stations end up running, each with its own encoder, each
  // believing it is fine, while phones reach whichever socket the OS picked. Measured: a
  // second instance bound 0.0.0.0:8090 without complaint. Refusing the bind turns that into
  // an error we can report instead of a mystery in the café.
  // Listen on '::' rather than '0.0.0.0': that serves IPv6 AND IPv4 clients on the same
  // socket. It matters because a phone reaching the PC by NAME gets IPv6 first — measured on
  // this machine, the hostname resolves to fe80::… before 192.168.1.14 — and an IPv4-only
  // socket refuses that connection. Browsers do fall back, but a refused first attempt is a
  // delay at best and a failure on clients that do not retry.
  let listenFellBack = false
  const httpServer = app.listen({ port, host: '::', exclusive: true },
    () => console.log(`Rovli Radyo API http://127.0.0.1:${port}`))
  // Without this handler a failed bind is an unhandled 'error' event. The desktop app catches
  // it only to open its window anyway, so the panel appeared over a station that was not
  // listening at all — and nothing on screen said why.
  httpServer.on('error', error => {
    // A machine with IPv6 switched off cannot bind '::' at all. Fall back to IPv4 rather than
    // refusing to start — the station must come up on whatever the PC actually supports.
    if (!listenFellBack && ['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EINVAL', 'EPROTONOSUPPORT'].includes(error?.code)) {
      listenFellBack = true
      console.log('IPv6 kullanılamıyor, IPv4 üzerinden dinleniyor.')
      httpServer.listen({ port, host: '0.0.0.0', exclusive: true })
      return
    }
    const message = error?.code === 'EADDRINUSE'
      ? `Port ${port} zaten kullanımda. Rovli Radyo'nun başka bir kopyası açık olabilir — Görev Yöneticisi'nden kapatıp tekrar deneyin.`
      : `Sunucu başlatılamadı: ${error?.message}`
    console.error(message)
    httpServer.startupError = message
  })
  // Also serve HTTPS (self-signed) so phones get a secure context for the mic. Generating
  // a key takes a moment, so HTTPS comes up slightly after HTTP rather than blocking it —
  // the Electron window waits on the HTTP listener, which is already live.
  let httpsServer = null
  let shuttingDown = false
  ensureCerts().then(creds => {
    if (shuttingDown) return
    httpsServer = https.createServer(creds, app)
    // Same dual-stack reasoning as the HTTP listener above — the announcement page is reached
    // by exactly the same addresses.
    let httpsFellBack = false
    httpsServer.on('error', error => {
      if (!httpsFellBack && ['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EINVAL', 'EPROTONOSUPPORT'].includes(error?.code)) {
        httpsFellBack = true
        httpsServer.listen({ port: httpsPort, host: '0.0.0.0', exclusive: true })
        return
      }
      console.error('HTTPS sunucu hatası:', error.message)
    })
    httpsServer.listen({ port: httpsPort, host: '::', exclusive: true },
      () => console.log(`Rovli Radyo HTTPS https://127.0.0.1:${httpsPort}`))
  }).catch(error => console.error('HTTPS başlatılamadı:', error.message))
  const shutdown = () => {
    shuttingDown = true
    clearInterval(tickTimer)      // stop ticks before closing so no write hits a dead socket
    // A coalesced broadcast still pending would fire into sockets we are about to end.
    if (broadcastTimer) { clearTimeout(broadcastTimer); broadcastTimer = null; broadcastPending = false }
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
    saveNow()                      // flush any pending debounced state to disk
    audioEngine.shutdown()
    for (const response of clients) { try { response.end() } catch {} }
    clients.clear()
    httpServer.close()
    try { httpsServer?.close() } catch {}
  }
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
  // Exposed so the desktop app can close the station DELIBERATELY. Windows does not deliver
  // SIGTERM/SIGINT to an Electron app being quit, so those handlers never ran in production
  // and the only cleanup was the process-exit hook — which kills ffmpeg but cannot end the
  // listeners' connections or stop the timers first. Electron calls this instead.
  httpServer.gracefulShutdown = shutdown
  return httpServer
}

if (require.main === module) {
  const server = startServer()
  // Started directly (npm start, or a stray second copy): a station that could not take its
  // port must not linger half-alive. Lingering is how two instances end up "running" at once,
  // with the operator unable to tell which one the phones are reaching. The desktop app does
  // not take this path — it handles the same event itself so it can show a dialog first.
  server.on('error', () => process.exit(1))
}
module.exports = { startServer }
