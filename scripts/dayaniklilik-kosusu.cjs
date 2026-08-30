// A café runs this station for sixteen hours without anyone touching it. Every test in this
// project finishes in seconds, so nothing has ever observed what happens after the hundredth
// track change, the thousandth broadcast, or four hours of a phone holding the stream open.
//
// The user's suspicion from the start was that "the engine has trouble on long runs". This is
// the instrument for answering that with numbers instead of a feeling. It is a script, not a
// test: it takes minutes to hours by design and must never sit in the suite.
//
//   node scripts/dayaniklilik-kosusu.cjs [dakika]
//
// What it watches, all of which have failed in this project before:
//   • silence — the pump deadlock left the station "playing" and producing nothing
//   • memory  — anything that accumulates per broadcast shows up as a slope, not a spike
//   • ffmpeg  — a leaked decoder per track is invisible until the PC has 400 of them
//   • state   — the file on disk must stay parseable through thousands of writes

const path = require('node:path')
const fs = require('node:fs')
const { startServer, makeTone, sleep } = require('../tests/helpers/harness.cjs')

const MINUTES = Number(process.argv[2] || 30)
const SAMPLE_EVERY_MS = 20000
const TRACK_SECONDS = 8            // short tracks so a long run sees many transitions

const stamp = () => new Date().toTimeString().slice(0, 8)
const say = line => console.log(`[${stamp()}] ${line}`)

// Resident set of the station process — the number that matters is the trend, not the value.
function rssMb(pid) {
  try {
    const { execFileSync } = require('node:child_process')
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      `(Get-Process -Id ${pid} -ErrorAction Stop).WorkingSet64`], { encoding: 'utf8' })
    return Math.round(Number(out.trim()) / 1048576)
  } catch { return null }
}

async function main() {
  say(`${MINUTES} dakikalık dayanıklılık koşusu başlıyor`)
  const music = Array.from({ length: 6 }, (_, i) => makeTone(TRACK_SECONDS, 300 + i * 60))
  const server = await startServer({ music, ads: [makeTone(3, 900)] })
  const statePath = path.join(server.dataDir, 'station.json')

  // A phone that connects once and never lets go — the café's actual usage.
  const meter = server.listen()
  await sleep(1000)
  await server.play()
  await server.api('/api/settings', 'PATCH', { adSettings: { songsEnabled: true, songsEvery: 2 } })

  const samples = []
  const problems = []
  const deadline = Date.now() + MINUTES * 60000
  let round = 0

  while (Date.now() < deadline) {
    await sleep(SAMPLE_EVERY_MS)
    round++

    const bytes = await meter.sample(3000)
    const state = await server.state()
    const children = server.children()
    const memory = rssMb(server.proc.pid)
    const elapsed = Math.round((MINUTES * 60000 - (deadline - Date.now())) / 60000 * 10) / 10

    samples.push({ elapsed, bytes, memory, ffmpeg: children.length })

    if (bytes === 0) problems.push(`${elapsed} dk: SESSİZLİK — 3 saniyede 0 bayt geldi`)
    if (state.capabilities.flowing === false) problems.push(`${elapsed} dk: motor akmıyor — ${state.capabilities.message}`)
    if (children.length > 4) problems.push(`${elapsed} dk: ${children.length} ffmpeg süreci — sızıntı olabilir`)
    try { JSON.parse(fs.readFileSync(statePath, 'utf8')) } catch { problems.push(`${elapsed} dk: durum dosyası okunamıyor`) }

    // Exercise the controls the operator actually uses, so the run is not just idle playback.
    if (round % 3 === 0) await server.api('/api/control', 'POST', { action: 'next' })
    if (round % 7 === 0) await server.api('/api/settings', 'PATCH', { playback: { shuffle: round % 14 === 0 } })

    say(`${elapsed} dk — ses ${bytes} bayt, bellek ${memory} MB, ffmpeg ${children.length}, geçmiş ${state.history.length}`)
  }

  const memories = samples.map(s => s.memory).filter(Number.isFinite)
  const first = memories.slice(0, 3)
  const last = memories.slice(-3)
  const average = list => list.reduce((sum, value) => sum + value, 0) / list.length
  const growth = memories.length >= 6 ? Math.round(average(last) - average(first)) : null

  console.log('\n──────── SONUÇ ────────')
  say(`örnek sayısı: ${samples.length}`)
  say(`ses: en az ${Math.min(...samples.map(s => s.bytes))} bayt, ortalama ${Math.round(average(samples.map(s => s.bytes)))}`)
  if (growth !== null) say(`bellek: ${first[0]} MB → ${last[last.length - 1]} MB (eğilim ${growth >= 0 ? '+' : ''}${growth} MB)`)
  say(`ffmpeg süreçleri: en fazla ${Math.max(...samples.map(s => s.ffmpeg))}`)

  if (problems.length) {
    console.log('\nSORUNLAR:')
    for (const line of problems) console.log('  • ' + line)
  } else {
    say('kayda değer bir sorun görülmedi')
  }

  meter.close()
  await server.stop()
  process.exit(problems.length ? 1 : 0)
}

main().catch(error => { console.error('koşu çöktü:', error); process.exit(1) })
