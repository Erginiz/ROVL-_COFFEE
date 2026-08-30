// Captures what the station is actually broadcasting and measures it.
//
// Everything else in this suite checks that bytes are flowing. Bytes flowing is not the
// promise the café bought — the promise is that the right sound comes out at the right level.
// A chain that silently halved every sample, or inverted a channel, or dropped the mic into
// a void, would pass every byte-counting test in here.

const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { execFileSync } = require('child_process')

const ffmpegPath = require(path.join(__dirname, '..', '..', 'node_modules', 'ffmpeg-static'))

// Records `seconds` of /live.mp3 to a file and returns its path.
function captureStream(port, seconds, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rovli-capture-')), 'capture.mp3')
    const out = fs.createWriteStream(file)
    const req = http.get({ host, port, path: '/live.mp3' }, res => {
      if (res.statusCode !== 200) { req.destroy(); reject(new Error('HTTP ' + res.statusCode)); return }
      res.pipe(out)
      setTimeout(() => {
        res.destroy()
        out.end(() => resolve(file))
      }, seconds * 1000)
    })
    req.on('error', reject)
  })
}

// Decodes the capture to raw mono PCM so it can be measured sample by sample. The first
// second is dropped: a listener attaching mid-stream starts inside an MP3 frame, and the
// decoder needs a moment before its output is trustworthy.
function decodeToPcm(file, { skipSeconds = 1 } = {}) {
  const raw = file + '.pcm'
  execFileSync(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error',
    '-ss', String(skipSeconds), '-i', file, '-ac', '1', '-ar', '48000', '-f', 's16le', raw])
  const buffer = fs.readFileSync(raw)
  const samples = new Int16Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.length / 2))
  return samples
}

// Root-mean-square level, as a fraction of full scale. This is "how loud is it" in the sense
// a listener means it, rather than the peak of a single sample.
function rms(samples) {
  if (!samples.length) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  return Math.sqrt(sum / samples.length) / 32768
}

// Dominant frequency of a (near-)pure tone, from the rate at which it crosses zero. Enough to
// tell 440 Hz from 880 Hz, which is all these tests need — and it needs no FFT.
function dominantFrequency(samples, sampleRate = 48000) {
  if (samples.length < 1000) return 0
  // A small threshold keeps decoder noise around the zero line from counting as crossings.
  const threshold = Math.max(200, rms(samples) * 32768 * 0.2)
  let crossings = 0
  let above = samples[0] > 0
  for (let i = 1; i < samples.length; i++) {
    const value = samples[i]
    if (above && value < -threshold) { crossings++; above = false }
    else if (!above && value > threshold) { crossings++; above = true }
  }
  return (crossings * sampleRate) / (2 * samples.length)
}

// Convenience: capture, decode, measure.
async function measureBroadcast(port, seconds = 5, options = {}) {
  const file = await captureStream(port, seconds, options.host)
  const samples = decodeToPcm(file, options)
  return {
    file,
    samples: samples.length,
    rms: rms(samples),
    frequency: dominantFrequency(samples),
    cleanup: () => { try { fs.rmSync(path.dirname(file), { recursive: true, force: true }) } catch {} }
  }
}

module.exports = { captureStream, decodeToPcm, rms, dominantFrequency, measureBroadcast }
