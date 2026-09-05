const net = require('node:net')

const ports = [5173, Number(process.env.PORT || 8090)]
const timeoutAt = Date.now() + 30000

function ready(port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    const done = value => { socket.destroy(); resolve(value) }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.setTimeout(500, () => done(false))
  })
}

async function main() {
  while (Date.now() < timeoutAt) {
    const results = await Promise.all(ports.map(ready))
    if (results.every(Boolean)) return
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  console.error(`Gelistirme sunuculari hazir degil: ${ports.join(', ')}`)
  process.exitCode = 1
}

main().catch(error => { console.error(error); process.exitCode = 1 })
