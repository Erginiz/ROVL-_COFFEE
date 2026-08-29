const { spawn } = require('child_process')
const path = require('path')
const ffmpegBinary = require('ffmpeg-static')
const ffmpegPath = process.resourcesPath && ffmpegBinary.includes('app.asar') ? ffmpegBinary.replace('app.asar', 'app.asar.unpacked') : ffmpegBinary

// ── Architecture ────────────────────────────────────────────────────────────
// ONE persistent MP3 encoder runs for the whole app lifetime. It is fed a raw
// PCM stream (s16le 48k stereo) that NEVER stops — silence when idle, music when
// playing, music+mic during announcements. Because the encoder and the /live.mp3
// byte stream never break, clients (PC + every phone) never stall, drift, or drop
// on a track change, a volume change, a mic toggle, or an ezan pause. This is the
// same principle real radio/streaming uses: keep the pipe alive, swap the source.
//
// Per-track DECODERS are short-lived: each decodes one file to PCM as fast as the
// disk allows (back-pressured so RAM stays bounded). The Node mixer meters that
// PCM into the encoder at real time (paced by ffmpeg's -re on the encoder input),
// applying master volume as a sample multiply and adding the mic samples live.

const RATE = 48000
const CHANNELS = 2
const BYTES_PER_FRAME = CHANNELS * 2          // 16-bit stereo → 4 bytes / frame
const CHUNK = RATE * 0.02 * BYTES_PER_FRAME   // 20 ms of audio = 3840 bytes
const SILENCE = Buffer.alloc(CHUNK)           // reused zero-filled chunk
const MIC_GAIN = 1.4                          // announcements sit above the music
// Soft limiter. Per-track normalisation boosts quiet files, and a boosted transient can
// exceed full scale; hard-clipping it is heard as a crackle. Above this fraction of full
// scale we bend into a tanh curve instead, so peaks compress smoothly and everything
// below the knee is left mathematically untouched. No lookahead buffer is used — that
// would add latency, which the rest of this work is trying to remove.
// The curve tops out BELOW full scale on purpose. Samples that never reach 32767 can
// still decode above it: MP3 is lossy, and the waveform reconstructed between samples
// overshoots the samples themselves. Measured at 200% with a 0 dBFS ceiling the stream
// came back at +1.9 dBFS true peak, which cheap DACs clip. Leaving ~1.5 dB of headroom
// costs almost no loudness (LUFS is an average; only the rare peak is touched) and keeps
// the decoded signal inside range.
const LIMIT_KNEE = 0.7
const LIMIT_CEILING = 0.84
const KNEE = 32767 * LIMIT_KNEE
const KNEE_RANGE = 32767 - KNEE                    // input span above the knee
const CEIL_RANGE = 32767 * LIMIT_CEILING - KNEE    // output span above the knee
// Keep 2–8 s of decoded audio buffered ahead: smooth playback, bounded memory.
const DECODE_HIGH = 1.5 * 1024 * 1024
const DECODE_LOW = 384 * 1024
// Drop the live-mic backlog if the mixer ever falls behind, so it can't grow RAM.
const MAX_MIC_BUFFER = 512 * 1024
// Slow/stuck clients that buffer more than this are dropped so one bad connection
// can never stall the encoder or grow memory without bound.
const MAX_CLIENT_BACKLOG = 4 * 1024 * 1024
// Audio-stall watchdog: while a track is supposed to be playing, a healthy decoder
// keeps musicQ fed. If NOTHING playable arrives for this long (a decoder hung on a
// disconnected network share, or a malformed file that emits nothing yet never
// closes), the whole broadcast would otherwise freeze with no recovery — so we treat
// it as a dead track and skip on. See the checkStall() note.
const STALL_MS = 8000
const STALL_CHECK_MS = 2000
// Output-health watchdog. The encoder is fed even when the station is idle (we write
// silence), so it must ALWAYS be emitting bytes. A gap means the pipeline itself is
// wedged rather than the current track — e.g. the pump parked on a `drain` that can
// never arrive because the process it belonged to died. Recycling the encoder clears
// that state. Verified: without this, one encoder crash silenced the station forever.
const OUTPUT_STALL_MS = 8000
// Cap simultaneous /live.mp3 listeners so a misbehaving client on the LAN can't open
// unbounded connections and exhaust sockets/memory.
const MAX_CLIENTS = 200

// The soft-limiter curve, as its own function so it can be tested directly: getting this
// wrong is audible as distortion rather than as a crash, which is exactly the kind of bug
// that ships unnoticed. Behaviour is identical to the inline version it replaces — below
// the knee the sample is returned untouched, above it the excess is bent through tanh.
function softLimit(s) {
  if (s > KNEE) s = KNEE + CEIL_RANGE * Math.tanh((s - KNEE) / KNEE_RANGE)
  else if (s < -KNEE) s = -KNEE + CEIL_RANGE * Math.tanh((s + KNEE) / KNEE_RANGE)
  // Absolute backstop: tanh is bounded, but this keeps a NaN or a rounding edge from
  // ever writing an out-of-range value.
  if (s > 32767) return 32767
  if (s < -32768) return -32768
  return s
}

// A simple FIFO of Buffers that hands back exactly N bytes at a time.
class ByteQueue {
  constructor() { this.chunks = []; this.len = 0 }
  push(buf) { if (buf && buf.length) { this.chunks.push(buf); this.len += buf.length } }
  pull(n) {
    if (this.len < n) return null
    const out = Buffer.allocUnsafe(n)
    let off = 0
    while (off < n) {
      const head = this.chunks[0]
      const need = n - off
      if (head.length <= need) { head.copy(out, off); off += head.length; this.len -= head.length; this.chunks.shift() }
      else { head.copy(out, off, 0, need); this.chunks[0] = head.subarray(need); this.len -= need; off += need }
    }
    return out
  }
  clear() { this.chunks = []; this.len = 0 }
}

class StreamHub {
  constructor() { this.clients = new Set() }
  attach(response) {
    if (this.clients.size >= MAX_CLIENTS) { try { response.writeHead(503).end() } catch {} return }
    response.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache',
      Connection: 'keep-alive',
      'icy-name': 'Rovli Radio',
      'icy-description': 'Rovli Radio local stream'
    })
    response.flushHeaders?.()
    response.socket?.setNoDelay?.(true)
    response.socket?.setTimeout?.(0)
    this.clients.add(response)
    const remove = () => this.clients.delete(response)
    response.on('close', remove)
    response.on('error', remove)
  }
  push(chunk) {
    for (const response of this.clients) {
      if (response.writableEnded || response.destroyed) { this.clients.delete(response); continue }
      if (response.writableLength > MAX_CLIENT_BACKLOG) { try { response.destroy() } catch {} this.clients.delete(response); continue }
      try { response.write(chunk) } catch { this.clients.delete(response) }
    }
  }
  close() {
    for (const response of this.clients) { try { response.end() } catch {} }
    this.clients.clear()
  }
}

class AudioEngine {
  constructor({ mediaRoots, getState, onTrackEnded, onTrackFailed, onError }) {
    this.mediaRoots = mediaRoots
    this.getState = getState
    this.onTrackEnded = onTrackEnded
    this.onTrackFailed = onTrackFailed
    this.onError = onError
    this.hub = new StreamHub()

    this.encoder = null            // persistent MP3 encoder (never dies while running)
    this.shuttingDown = false
    this.pumping = false           // re-entrancy guard for the feed loop

    // Loudness-normalisation gain for the track on air, as a linear multiplier. Cached
    // when the decoder starts rather than looked up per chunk: buildChunk runs 50×/s and
    // would otherwise search the whole library each time.
    this.currentGain = 1
    this.decoder = null            // current per-track PCM decoder
    this.generation = 0            // invalidates stale decoder callbacks
    this.musicQ = new ByteQueue()  // decoded PCM waiting to be metered out
    this.decPaused = false         // decoder stdout paused for back-pressure
    this.decoderEnded = false      // decoder finished producing (drain then advance)
    this.ended = false             // guard so a track advances exactly once

    // Live microphone: browser PCM → resampler → 48k stereo → mixed into the feed.
    this.micActive = false
    this.micProc = null
    this.micIn = null
    this.micQ = new ByteQueue()
    this.micSampleRate = 48000

    // Audio-stall watchdog state: timestamp of the last moment music actually made
    // progress (decoder produced bytes, or a chunk was metered out). checkStall() uses it.
    this.lastAudioProgress = Date.now()
    this.stallTimer = null
    // Last time the encoder actually produced output. Drives checkOutput() below.
    this.lastEncoderOutputAt = Date.now()
    // Encoder respawn backoff state: recent restart timestamps + the pending restart timer.
    // A single crash recovers instantly; a tight loop (ffmpeg failing to start) backs off so
    // it can't peg the CPU or flood the log over a long run.
    this.encoderRestarts = []
    this.encoderRestartTimer = null

    this.ensureEncoder()
    this.startStallWatch()
  }

  // While a track is playing but the decoder produces nothing for STALL_MS, the broadcast
  // would freeze silently (buildChunk keeps returning null, so the encoder starves). Detect
  // that and skip the track via the same path a corrupt file uses, so one hung decode can't
  // take the whole station down with no recovery.
  startStallWatch() {
    if (this.stallTimer) return
    this.stallTimer = setInterval(() => { this.checkStall(); this.checkOutput() }, STALL_CHECK_MS)
    this.stallTimer.unref?.()
  }

  // Defence in depth for the whole output path. checkStall() only watches the DECODER, so a
  // pipeline that is wedged downstream of it (pump parked, stdin never draining) looks
  // "healthy" to it while listeners hear nothing. The encoder is fed silence even when idle,
  // so a gap in its output is unambiguous: recycle it. Its close handler releases the pump
  // guard and schedules the respawn, so this single action revives the broadcast.
  checkOutput() {
    if (this.shuttingDown || !this.encoder || this.encoderRestartTimer) return
    if (Date.now() - this.lastEncoderOutputAt < OUTPUT_STALL_MS) return
    this.onError?.('Yayın çıkışı durdu — ses kodlayıcı yenileniyor')
    this.lastEncoderOutputAt = Date.now()   // one recycle per window, not a kill storm
    try { this.encoder.kill() } catch {}
  }
  checkStall() {
    if (this.shuttingDown) return
    const pb = this.getState().playback
    // Only meaningful while music is supposed to be flowing. When idle/paused, or the
    // decoder has cleanly finished (draining its buffer), there is nothing to rescue.
    if (pb.status !== 'playing' || !this.decoder || this.decoderEnded) { this.lastAudioProgress = Date.now(); return }
    if (Date.now() - this.lastAudioProgress < STALL_MS) return
    this.onError?.('Ses akışı durdu — parça atlanıyor')
    this.lastAudioProgress = Date.now()
    this.stopDecoder()
    // Same recovery the server uses for an unreadable file: advance and play the next.
    this.onTrackFailed?.()
  }

  // ── Persistent encoder ──────────────────────────────────────────────────────
  ensureEncoder() {
    if (this.encoder || this.shuttingDown) return
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-f', 's16le', '-ar', String(RATE), '-ac', String(CHANNELS), '-re', '-i', 'pipe:0',
      '-b:a', '128k', '-reservoir', '0', '-flush_packets', '1',
      '-write_xing', '0', '-id3v2_version', '0', '-f', 'mp3', 'pipe:1'
    ]
    try {
      const child = spawn(ffmpegPath, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      this.encoder = child
      this.lastEncoderOutputAt = Date.now()   // grace window before checkOutput() judges it
      child.stdin.on('error', () => {})   // ignore EPIPE on shutdown/respawn
      child.stdout.on('data', chunk => { this.lastEncoderOutputAt = Date.now(); this.hub.push(chunk) })
      child.stderr.on('data', data => this.reportEncoderError(data.toString().trim()))
      child.on('error', error => this.onError?.(error.message))
      child.on('close', () => {
        if (this.encoder === child) {
          this.encoder = null
          // CRITICAL: the pump loop was feeding THIS process and may be parked waiting for a
          // `drain` that can now never fire. Releasing the guard here is what lets the
          // respawned encoder actually be fed. Without it the station went permanently
          // silent after a single encoder crash (reproduced: 12s+ of zero bytes out, with a
          // healthy encoder sitting there unfed).
          this.pumping = false
          // Self-heal: bring the encoder straight back so the stream keeps flowing (a rare,
          // brief discontinuity for connected clients) — but through a backoff so a start
          // failure that repeats can't become a tight respawn loop over a long run.
          if (!this.shuttingDown) this.scheduleEncoderRestart()
        }
      })
      this.pump()
    } catch (error) {
      // A synchronous spawn failure emits no 'close', so nothing else would ever retry and
      // the station would stay silent for good. Schedule the retry ourselves.
      this.onError?.(error.message)
      this.encoder = null
      this.pumping = false
      if (!this.shuttingDown) this.scheduleEncoderRestart()
    }
  }

  // ffmpeg can emit the same stderr line many times a second on a bad input. Every call
  // reaches the server's onError, which appends to the history AND broadcasts full state to
  // every connected client, so an unthrottled stream of them floods the UI and the network.
  // Report at most one encoder error per 10s; identical repeats in between are dropped.
  reportEncoderError(message) {
    if (!message) return
    const now = Date.now()
    if (this._lastEncErrAt && now - this._lastEncErrAt < 10000) return
    this._lastEncErrAt = now
    this.onError?.(message)
  }

  // Respawn the encoder after a crash. Instant for an isolated crash; exponential backoff
  // (capped at 10s) once several restarts pile up inside a minute, so a persistently-failing
  // ffmpeg starve-loops the CPU/logs no longer.
  scheduleEncoderRestart() {
    if (this.shuttingDown || this.encoder || this.encoderRestartTimer) return
    const now = Date.now()
    this.encoderRestarts = this.encoderRestarts.filter(t => now - t < 60000)
    this.encoderRestarts.push(now)
    const rapid = this.encoderRestarts.length
    const delay = rapid <= 2 ? 0 : Math.min(10000, 250 * 2 ** (rapid - 3))
    if (rapid > 3) this.onError?.(`Ses kodlayıcı sık yeniden başlıyor (${rapid}/dk) — ${Math.round(delay / 1000)}sn bekleniyor`)
    this.encoderRestartTimer = setTimeout(() => {
      this.encoderRestartTimer = null
      this.ensureEncoder()
    }, delay)
    this.encoderRestartTimer.unref?.()
  }

  // The feed loop: keep the encoder's PCM input topped up. ffmpeg's -re consumes at
  // real time and back-pressures here, which is what paces the whole broadcast.
  pump() {
    if (this.pumping || !this.encoder) return
    // Bind this loop to the encoder it is feeding. `pumping` parks the loop until the
    // pipe drains, and a drain belonging to a process that has since died must not be
    // allowed to resume a stale loop (nor may it be waited on forever — see the close
    // handler, which releases the guard).
    const child = this.encoder
    const stdin = child.stdin
    if (!stdin || !stdin.writable) return
    this.pumping = true
    let writes = 0
    while (writes < 64) {
      const chunk = this.buildChunk()
      if (!chunk) break                       // playing but waiting on the decoder
      writes++
      this.maybeResumeDecoder()
      if (!stdin.write(chunk)) {               // pipe full → resume when it drains
        stdin.once('drain', () => {
          this.pumping = false
          if (this.encoder === child) this.pump()   // stale drain from a dead encoder: ignore
        })
        return
      }
    }
    this.pumping = false
    if (writes >= 64) setImmediate(() => this.pump())  // yield to the event loop, continue
    // If we stopped because the decoder had no data yet, its 'data' handler re-pumps.
  }

  // Build one 20 ms chunk of the broadcast: music (volume-applied) + mic, or silence.
  buildChunk() {
    const state = this.getState()
    const pb = state.playback
    const playing = pb.status === 'playing' && !!this.decoder
    let music = null
    if (playing) {
      const m = this.musicQ.pull(CHUNK)
      if (m) { music = m; this.lastAudioProgress = Date.now() }   // real audio flowed → not stalled
      else if (this.decoderEnded) this.handleTrackEnd()   // buffer drained → track over
      else return null                                    // transient underrun: wait
    }
    let mic = null
    if (this.micActive && this.micQ.len >= CHUNK) mic = this.micQ.pull(CHUNK)
    if (!music && !mic) return SILENCE
    // Music and ads carry independent broadcast levels; pick by what's playing now.
    // `pb.volume` is the legacy single-knob fallback for un-migrated state.
    const level = pb.currentType === 'ad'
      ? Number(pb.adVolume ?? pb.volume ?? 100)
      : Number(pb.musicVolume ?? pb.volume ?? 100)
    // Ceiling of 2, not 1: the operator can push a level past 100% when the café needs
    // more than the normalised level gives. The soft limiter below absorbs the peaks.
    // Must stay in step with MAX_VOLUME in index.cjs.
    const master = Math.max(0, Math.min(2, level / 100))
    const duck = this.micActive ? Math.max(0, 1 - Number(state.microphone?.ducking || 0) / 100) : 1
    // currentGain evens out the level difference between files so the operator's slider
    // means the same thing on every track. The mic is deliberately outside it — an
    // announcement should not be scaled by the loudness of whatever song is underneath.
    return this.mix(music, mic, master * duck * this.currentGain)
  }

  // Sum music and mic samples with gain, soft-limited into the 16-bit range.
  mix(music, mic, musicVol) {
    const out = Buffer.allocUnsafe(CHUNK)
    for (let i = 0; i < CHUNK; i += 2) {
      let s = 0
      if (music) s += music.readInt16LE(i) * musicVol
      if (mic && i < mic.length) s += mic.readInt16LE(i) * MIC_GAIN
      // The tanh call only runs for samples that actually reach the knee, so the common
      // case stays a plain multiply-and-add.
      out.writeInt16LE(softLimit(s) | 0, i)
    }
    return out
  }

  handleTrackEnd() {
    if (this.ended) return
    this.ended = true
    const gen = this.generation
    setImmediate(() => { if (gen === this.generation) this.onTrackEnded?.() })
  }

  maybeResumeDecoder() {
    if (this.decPaused && this.decoder && this.musicQ.len < DECODE_LOW) {
      this.decPaused = false
      try { this.decoder.stdout.resume() } catch {}
    }
  }

  fileForCurrent() {
    const state = this.getState()
    const item = [...state.music, ...state.ads].find(track => track.id === state.playback.currentId)
    if (!item || !state.playback.currentType) return null
    const kind = state.playback.currentType === 'ad' ? 'ad' : 'music'
    return { item, path: path.join(this.mediaRoots[kind], item.filename) }
  }

  // The real elapsed position of the current track — used as the resume point so a
  // track change / settings change starts the decoder WITHOUT jumping back to 0.
  positionSeconds() {
    const pb = this.getState().playback
    if (pb.status === 'playing' && pb.currentStartedAt) {
      return Math.max(0, (Date.now() - new Date(pb.currentStartedAt).getTime()) / 1000)
    }
    return Math.max(0, Number(pb.currentOffsetSeconds || 0))
  }

  // ── Per-track decoder ───────────────────────────────────────────────────────
  playCurrent() {
    this.ensureEncoder()
    this.stopDecoder()
    const state = this.getState()
    const source = this.fileForCurrent()
    // A track measured as gainDb 0, or not yet analysed, plays at its original level.
    const gainDb = Number(source?.item?.gainDb)
    this.currentGain = Number.isFinite(gainDb) ? 10 ** (gainDb / 20) : 1
    if (!source || state.playback.status !== 'playing') { this.pump(); return }  // → silence
    this.startDecoder(source.path, this.positionSeconds())
  }

  startDecoder(sourcePath, offset) {
    const gen = this.generation
    const seek = offset > 0.5 ? ['-ss', offset.toFixed(3)] : []
    const args = ['-hide_banner', '-loglevel', 'error', ...seek, '-i', sourcePath, '-vn', '-f', 's16le', '-ar', String(RATE), '-ac', String(CHANNELS), 'pipe:1']
    let bytes = 0
    this.lastAudioProgress = Date.now()   // give the fresh decoder a full stall window to start
    try {
      const child = spawn(ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      this.decoder = child
      this.ended = false
      this.decoderEnded = false
      this.decPaused = false
      child.stdout.on('data', chunk => {
        if (gen !== this.generation) return
        bytes += chunk.length
        this.lastAudioProgress = Date.now()   // decoder is alive and producing
        this.musicQ.push(chunk)
        if (this.musicQ.len > DECODE_HIGH && !this.decPaused) { this.decPaused = true; try { child.stdout.pause() } catch {} }
        this.pump()
      })
      child.stderr.on('data', data => this.onError?.(data.toString().trim()))
      child.on('error', error => this.onError?.(error.message))
      child.on('close', code => {
        if (gen !== this.generation) return
        this.decoderEnded = true
        if (code !== 0 && bytes < CHUNK * 2) {
          // Produced essentially nothing → corrupt/unreadable file → skip now.
          this.ended = true
          const g = this.generation
          setImmediate(() => { if (g === this.generation) this.onTrackFailed?.() })
        } else {
          this.pump()   // let the buffered PCM finish playing; end fires when it drains
        }
      })
      this.pump()
    } catch (error) { this.onError?.(error.message) }
  }

  // Stop the music source only — the encoder and the /live.mp3 stream stay alive
  // (so pause / ezan / stop just play silence, and resume is instant, gap-free).
  stopDecoder() {
    this.generation += 1
    this.decoderEnded = false
    this.decPaused = false
    this.ended = false
    this.musicQ.clear()
    const child = this.decoder
    this.decoder = null
    if (child) {
      try { child.stdout?.removeAllListeners() } catch {}
      try { child.stderr?.removeAllListeners() } catch {}
      try { child.kill() } catch {}
      const killTimer = setTimeout(() => { try { if (!child.killed) child.kill('SIGKILL') } catch {} }, 800)
      killTimer.unref?.()
      child.once('close', () => clearTimeout(killTimer))
    }
  }

  // Back-compat: server calls stop() on pause/stop/ezan. Only the source stops.
  stop() { this.stopDecoder(); this.pump() }
  refresh() { this.playCurrent() }

  // ── Live microphone ─────────────────────────────────────────────────────────
  startMic() {
    if (this.micActive) return
    this.micActive = true
    this.startMicResampler()
  }
  startMicResampler() {
    const rate = Math.max(8000, Math.min(96000, Number(this.micSampleRate) || 48000))
    const args = ['-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', String(rate), '-ac', '1', '-i', 'pipe:0', '-f', 's16le', '-ar', String(RATE), '-ac', String(CHANNELS), 'pipe:1']
    try {
      const child = spawn(ffmpegPath, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      this.micProc = child
      this.micIn = child.stdin
      child.stdin.on('error', () => {})
      child.stdout.on('data', chunk => {
        this.micQ.push(chunk)
        if (this.micQ.len > MAX_MIC_BUFFER) this.micQ.clear()   // fell behind → drop backlog, stay live
      })
      child.stderr.on('data', () => {})
      child.on('error', error => this.onError?.('Mikrofon: ' + error.message))
      child.on('close', () => {
        if (this.micProc !== child) return
        this.micProc = null
        this.micIn = null
        // If the announcement is still live, the resampler dying would otherwise silence it
        // for good: micActive stays true, so startMic() short-circuits and writeMic() drops
        // every chunk without a word. Bring the resampler back instead.
        if (this.micActive && !this.shuttingDown) {
          this.onError?.('Mikrofon köprüsü kapandı — yeniden başlatılıyor')
          setTimeout(() => { if (this.micActive && !this.micProc && !this.shuttingDown) this.startMicResampler() }, 300).unref?.()
        }
      })
    } catch (error) { this.onError?.(error.message) }
  }
  writeMic(chunk) {
    if (!this.micActive || !chunk || !chunk.length) return
    if (this.micIn && this.micIn.writable) { try { this.micIn.write(chunk) } catch {} }
  }
  stopMic() {
    if (!this.micActive) return
    this.micActive = false
    const child = this.micProc
    try { this.micIn?.end() } catch {}
    try { child?.kill() } catch {}
    // Same SIGKILL backstop the decoder and encoder get: a resampler that ignores the polite
    // kill must not survive as an orphan ffmpeg holding the mic pipe open.
    if (child) {
      const t = setTimeout(() => { try { if (!child.killed) child.kill('SIGKILL') } catch {} }, 800)
      t.unref?.()
      child.once('close', () => clearTimeout(t))
    }
    this.micProc = null
    this.micIn = null
    this.micQ.clear()
  }

  shutdown() {
    this.shuttingDown = true
    if (this.stallTimer) { clearInterval(this.stallTimer); this.stallTimer = null }
    if (this.encoderRestartTimer) { clearTimeout(this.encoderRestartTimer); this.encoderRestartTimer = null }
    this.stopMic()
    this.stopDecoder()
    const enc = this.encoder
    this.encoder = null
    if (enc) { try { enc.stdin?.end() } catch {} try { enc.kill() } catch {} const t = setTimeout(() => { try { if (!enc.killed) enc.kill('SIGKILL') } catch {} }, 800); t.unref?.() }
    this.hub.close()
  }
}

// ByteQueue and softLimit are exported for the unit tests: both are pure, and reaching
// them through a live AudioEngine would mean spawning ffmpeg to check arithmetic.
module.exports = { AudioEngine, ByteQueue, softLimit, LIMIT_KNEE, LIMIT_CEILING }
