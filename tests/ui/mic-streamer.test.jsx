import { afterEach, describe, expect, test, vi } from 'vitest'
import { createMicStreamer } from '../../src/mic-streamer.js'

class FakeNode {
  connect() { return this }
  disconnect() {}
}

class FakeProcessor extends FakeNode {
  onaudioprocess = null
}

class FakeAudioContext {
  static lastProcessor = null
  constructor() {
    this.sampleRate = 48000
    this.destination = new FakeNode()
  }
  resume() { return Promise.resolve() }
  close() { return Promise.resolve() }
  createMediaStreamSource() { return new FakeNode() }
  createScriptProcessor() {
    FakeAudioContext.lastProcessor = new FakeProcessor()
    return FakeAudioContext.lastProcessor
  }
  createGain() { return Object.assign(new FakeNode(), { gain: { value: 0 } }) }
}

function installCapture() {
  const track = { stop: vi.fn() }
  const stream = { getTracks: () => [track] }
  vi.stubGlobal('crypto', { randomUUID: () => 'mic-session-12345678' })
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('webkitAudioContext', undefined)
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => stream) } })
  return { track, stream }
}

function okResponse(status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => ({}), text: async () => '' }
}

afterEach(() => {
  vi.unstubAllGlobals()
  FakeAudioContext.lastProcessor = null
})

describe('mikrofon gönderici oturumu', () => {
  test('oturum kimliğiyle sırayı korur ve dururken son parçayı gönderir', async () => {
    installCapture()
    const calls = []
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
      calls.push({ url, options })
      return okResponse(url.endsWith('/api/mic/end') ? 204 : 200)
    }))
    const streamer = createMicStreamer({ headers: () => ({ 'x-admin-token': 'token' }) })

    await streamer.start()
    const startCall = calls.find(call => call.url.endsWith('/api/control'))
    const session = JSON.parse(startCall.options.body).micSessionId
    expect(session).toBe('mic-session-12345678')

    FakeAudioContext.lastProcessor.onaudioprocess({
      inputBuffer: { getChannelData: () => new Float32Array([0, 0.5, -1]) }
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    const chunkCall = calls.find(call => call.url.endsWith('/api/mic/chunk'))
    expect(chunkCall.options.headers['x-mic-session']).toBe(session)
    expect(chunkCall.options.body.byteLength).toBe(6)

    await streamer.stop()
    const endCall = calls.find(call => call.url.endsWith('/api/mic/end'))
    expect(endCall.options.headers['x-mic-session']).toBe(session)
    expect(calls.filter(call => call.url.endsWith('/api/mic/chunk'))).toHaveLength(1)
  })

  test('izin beklerken iptal edilirse mikrofon kaynağı sonradan da kapatılır', async () => {
    const capture = installCapture()
    let allowPermission
    navigator.mediaDevices.getUserMedia = vi.fn(() => new Promise(resolve => { allowPermission = resolve }))
    const calls = []
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
      calls.push({ url, options })
      return okResponse(url.endsWith('/api/control') ? 200 : 204)
    }))
    const streamer = createMicStreamer()
    const starting = streamer.start()
    await streamer.stop({ abort: true })
    allowPermission(capture.stream)
    await starting

    expect(capture.track.stop).toHaveBeenCalledTimes(1)
    expect(calls.some(call => call.url.endsWith('/api/mic/chunk'))).toBe(false)
    expect(calls.some(call => call.url.endsWith('/api/mic/end'))).toBe(false)
    const cancel = calls.find(call => call.url.endsWith('/api/control'))
    expect(JSON.parse(cancel.options.body).action).toBe('microphoneStop')
    expect(cancel.options.headers['Content-Type']).toBe('application/json')
  })
})
