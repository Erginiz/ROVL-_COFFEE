import { request } from './request.js'

// Keep capture, ordered delivery, and finishing separate: a normal stop must deliver
// the last words, while a failed or superseded session must never stop its successor.
export function createMicStreamer({ headers = () => ({}), onDropped, onExpired } = {}) {
  const session = crypto.randomUUID()
  let ctx, stream, proc, mute, source
  let phase = 'new', queue = [], queuedBytes = 0, flushing = null, finishing = null
  let notified = false
  const pending = new Set()
  const micHeaders = () => ({ ...headers(), 'x-mic-session': session })
  const send = async (url, options, timeout = 3000) => {
    const controller = new AbortController()
    pending.add(controller)
    try {
      const response = await request(url, { ...options, signal: controller.signal }, timeout)
      if (!response.ok) {
        if (response.status === 403) onExpired?.()
        throw new Error(response.status === 403 ? 'Yönetici oturumu sona erdi.'
          : response.status === 409 ? 'Anons sunucu tarafından sonlandırıldı veya başka bir anons açık.'
          : `Anons isteği başarısız: HTTP ${response.status}`)
      }
      return response
    } finally { pending.delete(controller) }
  }
  const releaseCapture = () => {
    if (proc) proc.onaudioprocess = null
    try { proc?.disconnect() } catch {}
    try { source?.disconnect() } catch {}
    try { mute?.disconnect() } catch {}
    try { stream?.getTracks().forEach(track => track.stop()) } catch {}
    try { ctx?.close()?.catch?.(() => {}) } catch {}
  }
  const cancelOwn = () => request('/api/control', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers() },
    body: JSON.stringify({ action: 'microphoneStop', micSessionId: session })
  }, 1500).catch(() => {})
  const fail = error => {
    if (phase === 'failed' || phase === 'ended') return
    phase = 'failed'
    releaseCapture()
    queue = []; queuedBytes = 0
    for (const controller of pending) controller.abort()
    void cancelOwn()
    if (!notified) { notified = true; onDropped?.(`Anons durduruldu: ${error?.message || 'bağlantı koptu'}`) }
  }
  const flush = () => {
    if (flushing) return flushing
    flushing = (async () => {
      while (queue.length && ['active', 'finishing'].includes(phase)) {
        const batch = queue; queue = []; queuedBytes = 0
        const merged = new Uint8Array(batch.reduce((n, item) => n + item.byteLength, 0))
        let offset = 0
        for (const item of batch) { merged.set(new Uint8Array(item), offset); offset += item.byteLength }
        await send('/api/mic/chunk', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', ...micHeaders() }, body: merged })
      }
    })().catch(error => { fail(error); throw error }).finally(() => { flushing = null })
    return flushing
  }
  const start = async () => {
    if (phase !== 'new') return
    phase = 'starting'
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      if (phase !== 'starting') { releaseCapture(); return }
      ctx = new (window.AudioContext || window.webkitAudioContext)()
      await ctx.resume?.()
      if (phase !== 'starting') { releaseCapture(); return }
      source = ctx.createMediaStreamSource(stream)
      proc = ctx.createScriptProcessor(2048, 1, 1)
      mute = ctx.createGain(); mute.gain.value = 0
      source.connect(proc); proc.connect(mute); mute.connect(ctx.destination)
      await send('/api/control', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...headers() },
        body: JSON.stringify({ action: 'microphoneStart', value: ctx.sampleRate, micSessionId: session })
      })
      if (phase !== 'starting') { releaseCapture(); await cancelOwn(); return }
      phase = 'active'
      proc.onaudioprocess = event => {
        if (phase !== 'active') return
        const input = event.inputBuffer.getChannelData(0)
        const pcm = new Int16Array(input.length)
        for (let i = 0; i < input.length; i++) {
          const value = Math.max(-1, Math.min(1, input[i]))
          pcm[i] = value < 0 ? value * 0x8000 : value * 0x7fff
        }
        queue.push(pcm.buffer); queuedBytes += pcm.byteLength
        // Bound pending audio by time, including 96 kHz capture devices.
        const limit = ctx.sampleRate * 2 * 0.25
        while (queuedBytes > limit && queue.length > 1) queuedBytes -= queue.shift().byteLength
        void flush().catch(() => {})
      }
    } catch (error) {
      const wasStarting = phase === 'starting'
      phase = 'failed'; releaseCapture(); queue = []; queuedBytes = 0
      await cancelOwn()
      if (wasStarting) throw error
    }
  }
  const stop = ({ abort = false } = {}) => {
    if (finishing) return finishing
    const previous = phase
    if (previous === 'ended' || previous === 'failed') { releaseCapture(); return Promise.resolve() }
    phase = abort || previous !== 'active' ? 'ended' : 'finishing'
    releaseCapture()
    finishing = (async () => {
      if (phase === 'ended') {
        queue = []; queuedBytes = 0
        for (const controller of pending) controller.abort()
        await cancelOwn()
        return
      }
      try {
        // An in-flight request must finish before EOF, or the final PCM would be rejected.
        if (flushing) await flushing
        if (queue.length) await flush()
        if (phase !== 'finishing') return
        await send('/api/mic/end', { method: 'POST', headers: micHeaders() })
        phase = 'ended'
      } catch (error) { fail(error) }
    })()
    return finishing
  }
  return { start, stop }
}
