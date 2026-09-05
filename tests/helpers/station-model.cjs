// Runs the production station functions with controlled I/O. This lets a test hold
// an actual await at a precise point, instead of hoping a race happens on a busy PC.
// Filesystem operations are real, restricted to this test's temporary directory;
// media probes and the external prayer API are injected. No station server is booted.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const crypto = require('node:crypto')

function section(source, start, end) {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from)
  if (from < 0 || to < 0) throw new Error(`Station test section missing: ${start}`)
  return source.slice(from, to)
}

function stationModel(t, { saved, Date: clock = Date, fetch: fetcher } = {}) {
  const source = fs.readFileSync(process.env.ROVLI_MODEL_SOURCE || path.join(__dirname, '../../server/index.cjs'), 'utf8')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rovli-model-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const mediaRoots = { music: path.join(root, 'Music'), ad: path.join(root, 'Ads') }
  const incomingRoot = path.join(root, '.uploads')
  for (const dir of [...Object.values(mediaRoots), incomingRoot]) fs.mkdirSync(dir)
  const routes = new Map()
  const c = {
    fs: { ...fs }, path, crypto, structuredClone, Date: clock, Math,
    AbortController, AbortSignal, encodeURIComponent, process: { env: {} },
    root, mediaRoots, incomingRoot, KIND_KEY: { music: 'music', ad: 'ads' },
    SCAN_AUDIO_RE: /\.(mp3|wav)$/i, LOUDNESS_PER_SCAN: 3, MAX_PROBE_ATTEMPTS: 3,
    MIN_ADS_EVERY: 1, MAX_ADS_EVERY: 500, MAX_TIMED_MINUTES: 1440,
    console: { error() {}, log() {} },
    requireAdmin() {}, upload: { single: () => () => {} },
    app: Object.fromEntries(['post', 'delete', 'patch'].map(method => [method, (route, ...handlers) => routes.set(`${method} ${route}`, handlers.at(-1))])),
    mediaRootFor: kind => mediaRoots[kind] || null,
    probeFile: async file => JSON.parse(fs.readFileSync(file, 'utf8')),
    probeLoudness: async file => JSON.parse(fs.readFileSync(file, 'utf8')).gainDb ?? 0,
    fetch: fetcher || (async () => { throw new Error('Unexpected network request') }),
    findActiveWindow: () => null, currentPositionSeconds: () => 0,
    audioEngine: { playCurrent() {}, stop() {} },
    broadcast() {}, save() {}, publicState: () => c.state,
    log: (type, title) => c.state.history.unshift({ type, title })
  }
  vm.createContext(c)
  vm.runInContext(section(source, 'const defaults =', '// A café loses power.'), c)
  c.state = saved ? c.mergeState(saved) : vm.runInContext('structuredClone(defaults)', c)
  vm.runInContext(section(source, 'function buildMusicQueue()', 'let consecutiveFailures ='), c)
  vm.runInContext(section(source, "app.patch('/api/settings',", '// A tag is only worth using'), c)
  vm.runInContext(section(source, "app.post('/api/media/:kind',", "app.get('*splat'"), c)
  vm.runInContext(section(source, 'let scanning = null', '// ── Durum raporu'), c)
  vm.runInContext(section(source, 'const PRAYER_MAP =', 'const ezanTimer ='), c)
  const write = (kind, filename, values = {}) => {
    const file = path.join(kind === 'incoming' ? incomingRoot : mediaRoots[kind], filename)
    fs.writeFileSync(file, JSON.stringify({ durationSeconds: 30, title: null, artist: null, gainDb: 0, ...values }))
    return file
  }
  const call = async (method, route, req = {}) => {
    const res = { statusCode: 200, status(n) { this.statusCode = n; return this }, json(value) { this.body = value; return this }, sendStatus(n) { this.statusCode = n; return this } }
    await routes.get(`${method} ${route}`)(req, res)
    return res
  }
  return { c, root, write, call }
}

const deferred = () => { let resolve; let reject; const promise = new Promise((ok, fail) => { resolve = ok; reject = fail }); return { promise, resolve, reject } }
module.exports = { stationModel, deferred }
