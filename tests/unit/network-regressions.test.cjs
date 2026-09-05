const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')

// These use the product functions without importing the station, which would start its
// encoder and write data. Fake sockets represent two routers without touching Windows.
const source = () => fs.readFileSync(path.join(__dirname, '../../server/index.cjs'), 'utf8')
test('teşhisin kendi LAN sorgusu çalışan Ethernet QR adresini Wi-Fi adresine çeviremez', () => {
  const addresses = [{ name: 'Ethernet', ip: '192.168.1.5' }, { name: 'Wi-Fi', ip: '192.168.2.5' }]
  const ctx = { Date, state: { station: {} }, listLanIps: () => addresses,
    os: { networkInterfaces: () => ({ Ethernet: [{ address: addresses[0].ip }], WiFi: [{ address: addresses[1].ip }] }) } }
  vm.createContext(ctx)
  const code = source()
  vm.runInContext(code.slice(code.indexOf('function scoreIp('), code.indexOf('function cleanListeners(')), ctx)
  ctx.noteReachedVia({ socket: { remoteAddress: '192.168.1.60', localAddress: '192.168.1.5' } })
  assert.equal(ctx.getLanIp(), '192.168.1.5')
  ctx.noteReachedVia({ headers: { 'x-rovli-diagnostic': '1' }, socket: { remoteAddress: '::ffff:192.168.2.5', localAddress: '::ffff:192.168.2.5' } })
  assert.equal(ctx.getLanIp(), '192.168.1.5')
  assert.equal(ctx.reachedViaList().length, 1, 'öz sorgu erişim kanıtı eklememeli')
})

test('sertifikadaki 140 adresi yeni 14 adresini kapsamış sayılmaz', async () => {
  const pems = await require('selfsigned').generate([{ name: 'commonName', value: 'test' }], {
    extensions: [{ name: 'subjectAltName', altNames: [{ type: 7, ip: '192.168.1.140' }] }]
  })
  const code = source()
  const ctx = { require, listLanIps: () => [{ ip: '192.168.1.14' }] }
  vm.createContext(ctx)
  vm.runInContext(code.slice(code.indexOf('function certCoversCurrentIps('), code.indexOf('async function ensureCerts(')), ctx)
  assert.equal(ctx.certCoversCurrentIps(pems.cert), false)
  ctx.listLanIps = () => [{ ip: '192.168.1.140' }]
  assert.equal(ctx.certCoversCurrentIps(pems.cert), true)
  assert.equal(ctx.certCoversCurrentIps('bozuk sertifika'), false)
})

test('IPv6 bağlama hatasından IPv4 geri dönüşü süreci kapatmaz', () => {
  const server = new EventEmitter()
  const attempts = []
  const exits = []
  server.listen = options => { attempts.push(options.host); return server }
  const moduleStub = { exports: {} }
  const ctx = { module: moduleStub, require: { main: moduleStub },
    app: { listen: () => server }, port: 18090, httpsPort: 18443,
    console: { log() {}, error() {} }, ensureCerts: () => new Promise(() => {}),
    process: { once() {}, exit: code => exits.push(code) },
    httpsStatus: { port: 18443, listening: false, error: null },
    setInterval: () => ({ unref() {} }), clearInterval() {} }
  vm.runInNewContext(source().slice(source().indexOf('function startServer(')), ctx)
  server.emit('error', Object.assign(new Error('IPv6 yok'), { code: 'EAFNOSUPPORT' }))
  assert.deepEqual(attempts, ['0.0.0.0'])
  assert.deepEqual(exits, [], 'geri dönüş sırasında CLI çıkmamalı')
  server.emit('error', Object.assign(new Error('port dolu'), { code: 'EADDRINUSE' }))
  assert.deepEqual(exits, [1], 'nihai hata CLI çıkışı olmalı')
})
