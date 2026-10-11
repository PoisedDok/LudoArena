// Repeatable load and concurrency run against a live stack (Node only, no extra tooling).
//   BASE_URL=http://app:4002 ADMIN_USERNAME=... ADMIN_PASSWORD=... PLAYERS=150 node scripts/load.mjs
// It creates PLAYERS throw-away players, signs them in, connects their sockets and then runs: dashboard
// refreshes, list reads, concurrent games from broadcast to settlement, one broadcast joined by many
// players at the same instant, parallel deposit uploads and PDF statements. It prints p50/p95/p99 per
// request type, the error count, and checks that every balance equals its ledger afterwards.
import { io } from 'socket.io-client'
import { randomBytes } from 'node:crypto'

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4002'
const PLAYERS = Number(process.env.PLAYERS ?? 150)
const PAIRS = Number(process.env.PAIRS ?? Math.floor(PLAYERS / 3))
const JOINERS = Number(process.env.JOINERS ?? 40)
const ADMIN_USERNAME = process.env.ADMIN_USERNAME
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD
if (!ADMIN_USERNAME || !ADMIN_PASSWORD) {
  console.error('ADMIN_USERNAME and ADMIN_PASSWORD are required')
  process.exit(2)
}

const samples = new Map()
const failures = []
const record = (name, ms, ok) => {
  if (!samples.has(name)) samples.set(name, { ms: [], errors: 0 })
  const s = samples.get(name)
  s.ms.push(ms)
  if (!ok) s.errors++
}

let clientCounter = 0

class Client {
  cookie = ''
  // Every simulated phone gets its own address in X-Forwarded-For, as every visitor has behind Cloudflare;
  // otherwise the per-address API limit would throttle the whole run as one client.
  address = `10.${(++clientCounter >> 16) & 255}.${(clientCounter >> 8) & 255}.${clientCounter & 255}`
  async call(name, method, path, body, { expect = [200, 201] } = {}) {
    const headers = { 'x-forwarded-for': this.address, ...(this.cookie ? { cookie: this.cookie } : {}) }
    let payload = body
    if (body && !(body instanceof FormData)) {
      headers['content-type'] = 'application/json'
      payload = JSON.stringify(body)
    }
    const started = performance.now()
    let res
    try {
      res = await fetch(BASE + path, { method, headers, body: payload })
    } catch (error) {
      record(name, performance.now() - started, false)
      failures.push(`${name}: ${error.message}`)
      return { status: 0, body: null }
    }
    const buffer = Buffer.from(await res.arrayBuffer())
    const ms = performance.now() - started
    const ok = expect.includes(res.status)
    record(name, ms, ok)
    const set = res.headers.getSetCookie?.() ?? []
    const token = set.find((c) => c.startsWith('token='))
    if (token) this.cookie = token.split(';')[0]
    let json = null
    if ((res.headers.get('content-type') ?? '').includes('json')) json = JSON.parse(buffer.toString() || 'null')
    if (!ok) failures.push(`${name}: HTTP ${res.status} ${buffer.toString().slice(0, 120)}`)
    return { status: res.status, body: json, bytes: buffer.length }
  }
}

async function pool(items, size, fn) {
  let next = 0
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      await fn(items[i], i)
    }
  })
  await Promise.all(workers)
}

const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(2048)])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]

const run = randomBytes(3).toString('hex')
const password = randomBytes(10).toString('hex')
const t0 = Date.now()

// ---- setup: admin, players, logins, sockets ----
const admin = new Client()
await admin.call('login (admin)', 'POST', '/api/auth/login', { username: ADMIN_USERNAME, password: ADMIN_PASSWORD })
const players = []
await pool([...Array(PLAYERS).keys()], 8, async (i) => {
  const username = `ld${run}_${i}`
  const res = await admin.call('create player', 'POST', '/api/players', { username, password, balance: 5000, creditLimit: 1000, spendLimit: 1000 })
  if (res.status === 201) players.push({ id: res.body.data.id, username, client: new Client() })
})
await pool(players, 10, async (p) => {
  await p.client.call('login (player)', 'POST', '/api/auth/login', { username: p.username, password })
})
const sockets = []
let socketEvents = 0
await pool(players, 25, async (p) => {
  await new Promise((resolve) => {
    const s = io(BASE, { extraHeaders: { cookie: p.client.cookie }, transports: ['websocket'], reconnection: false })
    s.onAny(() => socketEvents++)
    s.once('connect', resolve)
    s.once('connect_error', resolve)
    sockets.push(s)
  })
})
const connected = sockets.filter((s) => s.connected).length
await pool(players, 20, (p) => p.client.call('toggle active', 'PATCH', `/api/players/${p.id}/active`, { isActive: true }))
console.log(`setup: ${players.length} players, ${connected} sockets connected, ${((Date.now() - t0) / 1000).toFixed(1)} s`)

// ---- phase 1: reads ----
const phase1 = Date.now()
await Promise.all([
  pool([...Array(60).keys()], 6, () => admin.call('admin stats', 'GET', '/api/admin/stats?period=this-month')),
  pool([...Array(40).keys()], 4, () => admin.call('admin games list', 'GET', '/api/admin/games?limit=20')),
  pool(players, 20, async (p) => {
    await p.client.call('players list', 'GET', '/api/players')
    await p.client.call('my pings', 'GET', '/api/pings')
    await p.client.call('my games', 'GET', '/api/games')
    await p.client.call('my history', 'GET', `/api/players/${p.id}/transactions`)
  }),
])
console.log(`phase 1 (reads): ${((Date.now() - phase1) / 1000).toFixed(1)} s`)

// ---- phase 2: concurrent games ----
const phase2 = Date.now()
const pairPlayers = players.slice(0, PAIRS * 2)
const gameIds = []
await pool([...Array(PAIRS).keys()], 25, async (i) => {
  const a = pairPlayers[i * 2]
  const b = pairPlayers[i * 2 + 1]
  const ping = await a.client.call('ping create', 'POST', '/api/pings', { gameType: 'ONE_V_ONE', stake: 50 + (i % 7) * 10, recipientIds: [b.id] })
  if (!ping.body?.data) return
  const join = await b.client.call('ping accept', 'PATCH', `/api/pings/${ping.body.data.id}/respond`, { response: 'ACCEPTED' })
  if (!(join.body?.data?.started ?? join.body?.data?.status === 'accepted')) return
  const games = await a.client.call('my games', 'GET', '/api/games')
  const game = games.body.data[0]
  gameIds.push(game.id)
  await a.client.call('room code', 'PATCH', `/api/games/${game.id}/roomcode`, { ludoRoomCode: `R${i}X${run}`.slice(0, 12) })
  await a.client.call('mark done', 'PATCH', `/api/games/${game.id}/done`)
  const form = new FormData()
  form.append('screenshot', new Blob([png()], { type: 'image/png' }), 'win.png')
  await a.client.call('screenshot upload', 'POST', `/api/games/${game.id}/screenshots`, form)
  await Promise.all([
    a.client.call('vote', 'POST', `/api/games/${game.id}/confirm`, { winnerId: a.id }),
    b.client.call('vote', 'POST', `/api/games/${game.id}/confirm`, { winnerId: a.id }),
  ])
})
console.log(`phase 2 (${gameIds.length} games voted): ${((Date.now() - phase2) / 1000).toFixed(1)} s`)

// ---- phase 3: one broadcast, many joiners at the same instant ----
const rest = players.slice(PAIRS * 2)
const sender = rest[0]
const joiners = rest.slice(1, 1 + JOINERS)
let burst = { games: 0, accepted: 0, rejected: 0 }
if (sender && joiners.length > 1) {
  const ping = await sender.client.call('broadcast create', 'POST', '/api/pings', { gameType: 'ONE_V_ONE', stake: 20, isBroadcast: true })
  const started = performance.now()
  const results = await Promise.all(joiners.map((j) => j.client.call('burst join', 'PATCH', `/api/pings/${ping.body.data.id}/respond`, { response: 'ACCEPTED' }, { expect: [200, 409] })))
  burst = {
    games: results.filter((r) => r.status === 200 && r.body?.data?.started).length,
    accepted: results.filter((r) => r.status === 200).length,
    rejected: results.filter((r) => r.status === 409).length,
    ms: Math.round(performance.now() - started),
  }
  console.log(`phase 3 (${joiners.length} simultaneous joins): games started ${burst.games}, 409s ${burst.rejected}, ${burst.ms} ms`)
}

// ---- phase 4: deposits and statements in parallel ----
const phase4 = Date.now()
const depositors = players.slice(0, 30)
await Promise.all([
  pool(depositors, 10, async (p) => {
    const form = new FormData()
    form.append('amount', '100')
    form.append('screenshot', new Blob([png()], { type: 'image/png' }), 'pay.png')
    await p.client.call('deposit submit', 'POST', '/api/deposits', form)
  }),
  pool(players.slice(0, 12), 4, (p) => p.client.call('statement pdf', 'GET', `/api/players/${p.id}/statement.pdf?period=this-month`, undefined, { expect: [200, 429] })),
])
const pending = await admin.call('deposits list', 'GET', '/api/deposits/admin?status=PENDING')
await pool(pending.body?.data ?? [], 6, (d) => admin.call('deposit approve', 'PATCH', `/api/deposits/admin/${d.id}`, { action: 'APPROVED' }))
console.log(`phase 4 (deposits + statements): ${((Date.now() - phase4) / 1000).toFixed(1)} s`)

// ---- wait for settlements, then verify money ----
const deadline = Date.now() + 60_000
let settled = 0
while (Date.now() < deadline) {
  const res = await admin.call('admin games list', 'GET', '/api/admin/games?status=COMPLETED&limit=200')
  settled = res.body?.data?.games?.filter((g) => gameIds.includes(g.id)).length ?? 0
  if (settled >= gameIds.length) break
  await sleep(1000)
}
console.log(`settled ${settled}/${gameIds.length} games`)

let mismatches = 0
await pool(players, 10, async (p) => {
  const me = await p.client.call('me', 'GET', '/api/auth/me')
  const tx = await p.client.call('my history', 'GET', `/api/players/${p.id}/transactions`)
  if (!me.body?.data || !tx.body?.data) return // a player whose sign-in failed has no session; the failure is reported above
  // Players are created through the API with an opening balance, which is itself a ledger row.
  const sum = tx.body.data.reduce((s, t) => s + Math.round(t.amount * 100), 0)
  if (Math.round(me.body.data.balance * 100) !== sum) mismatches++
})

for (const s of sockets) s.close()

// ---- report ----
const rows = [...samples.entries()].map(([name, s]) => {
  const sorted = [...s.ms].sort((a, b) => a - b)
  return { name, n: sorted.length, p50: percentile(sorted, 50), p95: percentile(sorted, 95), p99: percentile(sorted, 99), max: sorted.at(-1), errors: s.errors }
})
console.log('\nrequest'.padEnd(26) + 'n'.padStart(6) + 'p50'.padStart(9) + 'p95'.padStart(9) + 'p99'.padStart(9) + 'max'.padStart(9) + 'errors'.padStart(8))
for (const r of rows) {
  console.log(r.name.padEnd(25) + String(r.n).padStart(6) + r.p50.toFixed(0).padStart(9) + r.p95.toFixed(0).padStart(9) + r.p99.toFixed(0).padStart(9) + r.max.toFixed(0).padStart(9) + String(r.errors).padStart(8))
}
const total = rows.reduce((s, r) => s + r.n, 0)
const errors = rows.reduce((s, r) => s + r.errors, 0)
console.log(`\nrequests ${total}, errors ${errors} (${((errors / Math.max(1, total)) * 100).toFixed(2)}%), socket events received ${socketEvents}`)
console.log(`games ${settled}/${gameIds.length} settled, burst: ${JSON.stringify(burst)}, balance/ledger mismatches ${mismatches}`)
if (failures.length) console.log(`first failures:\n  ${failures.slice(0, 8).join('\n  ')}`)
console.log(`wall time ${((Date.now() - t0) / 1000).toFixed(1)} s`)
process.exit(errors > 0 || mismatches > 0 || burst.games > 1 || settled < gameIds.length ? 1 : 0)
