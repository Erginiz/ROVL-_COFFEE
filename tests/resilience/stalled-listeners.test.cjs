// A café Wi-Fi drops. Every phone stops reading at the same moment, and none of them sends a
// FIN — they are simply out of range. The station keeps writing into each socket, and until
// something says stop, that audio sits in this machine's memory.
//
// Measured before any of this was written: twelve deaf listeners took the station from 76 MB
// to 102 MB in four minutes, about 2 MB each and still climbing.
//
// What that measurement does NOT show, and what took a second experiment to find out, is
// where the bytes are. On loopback, Windows absorbs everything into kernel socket buffers and
// the server's own write queue never grows at all — a deaf listener here is still connected
// after five minutes having read nothing. So the drop guard cannot be demonstrated against a
// local server, and pretending otherwise with a test that hangs would be worse than useless.
//
// The split, then: the guard's own logic is checked directly against StreamHub, and what the
// running station can honestly show — that a brief stall is tolerated — is checked here.

const test = require('node:test')
const assert = require('node:assert')
const net = require('node:net')
const { EventEmitter } = require('node:events')
const { startServer, makeTone, sleep } = require('../helpers/harness.cjs')
const { StreamHub, MAX_CLIENT_BACKLOG } = require('../../server/audio-engine.cjs')

// Stands in for an HTTP response whose reader has stopped: writes succeed, nothing drains.
function backedUpResponse(queued) {
  const response = new EventEmitter()
  Object.assign(response, {
    writableEnded: false, destroyed: false, writableLength: queued,
    writeHead() { return response }, end() { response.writableEnded = true },
    flushHeaders() {}, write() { return true },
    destroy() { response.destroyed = true },
    socket: { setNoDelay() {}, setTimeout() {} }
  })
  return response
}

test('kuyruğu şişen dinleyici düşürülür, sağlıklı olan kalır', () => {
  // The guard itself, with the operating system taken out of the picture. Over real Wi-Fi the
  // kernel window is small and this queue is what grows; on loopback it never does, which is
  // why this is a unit test and not an integration one.
  const hub = new StreamHub()
  const healthy = backedUpResponse(0)
  const backedUp = backedUpResponse(MAX_CLIENT_BACKLOG + 1)
  hub.attach(healthy)
  hub.attach(backedUp)
  assert.equal(hub.clients.size, 2)

  hub.push(Buffer.alloc(3840))

  assert.equal(backedUp.destroyed, true, 'geride kalan bağlantı kapatılmalı')
  assert.equal(healthy.destroyed, false, 'sağlıklı dinleyici etkilenmemeli')
  assert.equal(hub.clients.size, 1)
})

test('eşiğin altındaki birikme düşürülmez', () => {
  // The backlog exists to ride out a hiccup. A guard that fired just under the limit would
  // drop phones for a moment of bad signal and make the café's radio stutter for no reason.
  const hub = new StreamHub()
  const hiccuping = backedUpResponse(MAX_CLIENT_BACKLOG - 1)
  hub.attach(hiccuping)
  hub.push(Buffer.alloc(3840))
  assert.equal(hiccuping.destroyed, false)
  assert.equal(hub.clients.size, 1)
})

test('eşik canlı yayın için makul bir süreye denk gelir', () => {
  // 128 kbps is 16 KB/s. The number matters in seconds, not bytes: too short and an ordinary
  // Wi-Fi hiccup disconnects a phone, too long and a station holds minutes of audio nobody
  // will ever hear — this is a LIVE stream, and a phone that comes back seeks to the edge.
  const seconds = MAX_CLIENT_BACKLOG / (128000 / 8)
  assert.ok(seconds > 10, `eşik çok kısa (${Math.round(seconds)} sn) — küçük takılmalar bağlantıyı koparır`)
  assert.ok(seconds < 90, `eşik çok uzun (${Math.round(seconds)} sn) — telefon başına o kadar ses bellekte tutulur`)
})

test('kısa takılan telefon düşürülmez', { timeout: 180000 }, async t => {
  // The same trade against the real server: a few seconds of a phone not reading is an
  // ordinary hiccup and must not cost it the connection.
  const server = await startServer({ music: [makeTone(120, 440)] })
  t.after(() => server.stop())
  await server.play()
  await sleep(2000)

  const socket = net.connect(server.port, '127.0.0.1')
  t.after(() => socket.destroy())
  let closed = false
  socket.on('error', () => {})
  socket.on('close', () => { closed = true })
  await new Promise(resolve => socket.on('connect', resolve))
  socket.write('GET /live.mp3 HTTP/1.1\r\nHost: test\r\n\r\n')
  socket.resume()
  await sleep(3000)

  socket.pause()                 // ağ takıldı
  await sleep(8000)
  socket.resume()                // ve geri geldi
  await sleep(3000)

  assert.equal(closed, false, 'sekiz saniyelik takılma bağlantıyı koparmamalı')
})

test('çok sayıda tıkanan dinleyici belleği şişirmez', { timeout: 300000 }, async t => {
  // The café's actual bad day: the access point reboots and every phone goes deaf at once.
  // On this machine most of what grows is kernel socket buffering rather than the station's
  // own queue, so this is not a test of the guard above — it is a bound on the whole
  // behaviour, which is what the café's PC actually has to survive.
  const server = await startServer({ music: [makeTone(300, 440)] })
  t.after(() => server.stop())
  await server.play()
  await sleep(2000)

  const before = rssMb(server.proc.pid)
  assert.ok(before, 'bellek ölçülebilmeli')

  const sockets = Array.from({ length: 12 }, () => {
    const socket = net.connect(server.port, '127.0.0.1')
    socket.on('connect', () => { socket.write('GET /live.mp3 HTTP/1.1\r\nHost: test\r\n\r\n'); socket.pause() })
    socket.on('error', () => {})
    return socket
  })
  t.after(() => sockets.forEach(s => s.destroy()))
  await sleep(90000)

  const after = rssMb(server.proc.pid)
  assert.ok(after - before < 60,
    `12 tıkanmış dinleyici belleği ${after - before} MB büyüttü (${before} -> ${after})`)
})

function rssMb(pid) {
  try {
    const { execFileSync } = require('node:child_process')
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      `(Get-Process -Id ${pid} -ErrorAction Stop).WorkingSet64`], { encoding: 'utf8' })
    return Math.round(Number(out.trim()) / 1048576)
  } catch { return null }
}
