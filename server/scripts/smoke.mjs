// End-to-end smoke of a running stack: one scripted game from ping to settlement over HTTP and sockets.
//   BASE_URL=http://app:4002 ADMIN_USERNAME=... ADMIN_PASSWORD=... node scripts/smoke.mjs
// Secrets come from the environment only. Exit code 0 means every step passed.
import { io } from 'socket.io-client'
import { randomBytes } from 'node:crypto'

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4002'
const ADMIN_USERNAME = process.env.ADMIN_USERNAME
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD
if (!ADMIN_USERNAME || !ADMIN_PASSWORD) {
  console.error('ADMIN_USERNAME and ADMIN_PASSWORD are required')
  process.exit(2)
}

let steps = 0
const ok = (name) => console.log(`ok ${++steps} - ${name}`)
const fail = (name, detail) => {
  console.error(`FAIL - ${name}${detail ? `: ${detail}` : ''}`)
  process.exit(1)
}
const assert = (cond, name, detail) => (cond ? ok(name) : fail(name, detail))

class Client {
  cookie = ''
  async request(method, path, body, extra = {}) {
    const headers = { ...(this.cookie ? { cookie: this.cookie } : {}), ...(extra.headers ?? {}) }
    let payload = body
    if (body && !(body instanceof FormData)) {
      headers['content-type'] = 'application/json'
      payload = JSON.stringify(body)
    }
    const res = await fetch(BASE + path, { method, headers, body: payload, redirect: 'manual' })
    const set = res.headers.getSetCookie?.() ?? []
    const token = set.find((c) => c.startsWith('token='))
    if (token) this.cookie = token.split(';')[0]
    return res
  }
  async json(method, path, body) {
    const res = await this.request(method, path, body)
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers }
  }
}

const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(48)])
const waitFor = (predicate, label, ms = 30_000) =>
  new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      const value = predicate()
      if (value) return resolve(value)
      if (Date.now() - started > ms) return reject(new Error(`timed out waiting for ${label}`))
      setTimeout(tick, 100)
    }
    tick()
  })

function listen(client) {
  const events = []
  const socket = io(BASE, { extraHeaders: { cookie: client.cookie }, transports: ['websocket'], reconnection: false })
  socket.onAny((name, payload) => events.push({ name, payload }))
  return { socket, events }
}

const ready = await fetch(`${BASE}/api/ready`)
assert(ready.status === 200, 'GET /api/ready answers 200')
const health = await fetch(`${BASE}/api/health`, { headers: { 'x-forwarded-proto': 'https' } })
assert(health.status === 200, 'health is not redirected without the http header')
const redirected = await fetch(`${BASE}/api/health`, { headers: { 'x-forwarded-proto': 'http' }, redirect: 'manual' })
assert(process.env.EXPECT_REDIRECT === '0' || redirected.status === 308, 'plain-http visitors are redirected to https', String(redirected.status))
const shell = await fetch(`${BASE}/`)
assert(shell.status === 200 || process.env.EXPECT_SHELL === '0', 'the client shell is served')
const missing = await fetch(`${BASE}/api/does-not-exist`)
assert(missing.status === 404 && (missing.headers.get('content-type') ?? '').includes('json'), 'unknown API path is a JSON 404')
const legacyUploads = await fetch(`${BASE}/uploads/x.png`)
assert(legacyUploads.status === 404, '/uploads is no longer public')

const admin = new Client()
const bad = await admin.json('POST', '/api/auth/login', { username: ADMIN_USERNAME, password: 'definitely-wrong-password' })
assert(bad.status === 401, 'a wrong admin password is refused')
const login = await admin.json('POST', '/api/auth/login', { username: ADMIN_USERNAME, password: ADMIN_PASSWORD })
assert(login.status === 200 && login.body.data.role === 'ADMIN' && !('token' in login.body.data), 'admin signs in; no token in the body')

const run = randomBytes(3).toString('hex')
const names = [`smokea_${run}`, `smokeb_${run}`]
const password = randomBytes(10).toString('hex')
const players = []
for (const username of names) {
  const created = await admin.json('POST', '/api/players', { username, password, balance: 1000, creditLimit: 500, spendLimit: 1000 })
  assert(created.status === 201, `admin creates ${username}`, JSON.stringify(created.body))
  const client = new Client()
  const session = await client.json('POST', '/api/auth/login', { username, password, remember: false })
  assert(session.status === 200, `${username} signs in`)
  players.push({ id: created.body.data.id, username, client })
}
const [a, b] = players
const listenerA = listen(a.client)
const listenerB = listen(b.client)
await waitFor(() => listenerA.socket.connected && listenerB.socket.connected, 'sockets to connect')
ok('both players are connected over the socket with the session cookie')

const anonymousSocket = io(BASE, { transports: ['websocket'], reconnection: false })
await new Promise((resolve) => anonymousSocket.once('connect_error', resolve))
anonymousSocket.close()
ok('a socket without a session is refused')

// Broadcasts go to players who are active (the dashboard toggle).
const activate = await b.client.json('PATCH', `/api/players/${b.id}/active`, { isActive: true })
assert(activate.status === 200 && activate.body.data.isActive === true, 'B goes active')
const ping = await a.client.json('POST', '/api/pings', { gameType: 'ONE_V_ONE', stake: 200, isBroadcast: true })
assert(ping.status === 201, 'A broadcasts a Solo game for 200')
await waitFor(() => listenerB.events.some((e) => e.name === 'ping:broadcast_new'), 'B to receive the broadcast')
ok('B receives the broadcast')
const join = await b.client.json('PATCH', `/api/pings/${ping.body.data.id}/respond`, { response: 'ACCEPTED' })
assert(join.status === 200 && join.body.data.started === true, 'B joins and the game starts')
const accepted = await waitFor(() => listenerA.events.find((e) => e.name === 'ping:accepted'), 'A to receive ping:accepted')
const gameId = accepted.payload.game.id

const code = await a.client.json('PATCH', `/api/games/${gameId}/roomcode`, { ludoRoomCode: 'AB12CD34' })
assert(code.status === 200, 'A shares the room code')
await waitFor(() => listenerB.events.some((e) => e.name === 'game:roomcode'), 'B to see the room code')
ok('B sees the room code live')

assert((await a.client.json('PATCH', `/api/games/${gameId}/done`)).status === 200, 'A marks the game done')
const form = new FormData()
form.append('screenshot', new Blob([png()], { type: 'image/png' }), 'win.png')
const shot = await a.client.request('POST', `/api/games/${gameId}/screenshots`, form)
const shotBody = await shot.json()
assert(shot.status === 201, 'A uploads the win screenshot', JSON.stringify(shotBody))
const file = shotBody.data.filename

const voteA = await a.client.json('POST', `/api/games/${gameId}/confirm`, { winnerId: a.id })
const voteB = await b.client.json('POST', `/api/games/${gameId}/confirm`, { winnerId: a.id })
assert(voteA.status === 200 && voteB.body.data.status === 'settling', 'both vote; the undo window starts', JSON.stringify(voteB.body))
const started = Date.now()
await waitFor(() => listenerA.events.find((e) => e.name === 'game:completed'), 'settlement', 40_000)
ok(`settled ${((Date.now() - started) / 1000).toFixed(1)} s after the last vote`)
const doneA = listenerA.events.find((e) => e.name === 'game:completed').payload
const doneB = await waitFor(() => listenerB.events.find((e) => e.name === 'game:completed'), 'B settlement event')
assert(doneA.balance === 1190 && doneB.payload.balance === 800, 'balances are 1190 and 800 (stake 200, 5% commission)', JSON.stringify([doneA.balance, doneB.payload.balance]))
assert(!('balances' in doneA), 'the settlement event carries only the receiver balance')

const tx = await a.client.json('GET', `/api/players/${a.id}/transactions`)
const sum = tx.body.data.filter((t) => t.gameId === gameId).reduce((s, t) => s + Math.round(t.amount * 100), 0)
assert(sum === 19000, 'A ledger rows for the game add up to +190.00', String(sum))
assert(tx.body.data[0].balanceAfter === 1190, 'the newest ledger row carries the running balance')

const pdf = await a.client.request('GET', `/api/players/${a.id}/statement.pdf?period=all`)
const bytes = Buffer.from(await pdf.arrayBuffer())
assert(pdf.status === 200 && bytes.subarray(0, 5).toString() === '%PDF-' && (pdf.headers.get('content-disposition') ?? '').startsWith('attachment'), 'A downloads a PDF statement', `${pdf.status} ${bytes.length}`)
assert((await b.client.json('GET', `/api/players/${a.id}/statement.pdf`)).status === 403, "B cannot download A's statement")

const stats = await admin.json('GET', '/api/admin/stats')
assert(stats.status === 200 && stats.body.data.totals.games >= 1 && stats.body.data.totals.volume >= 200, 'admin dashboard shows the game', JSON.stringify(stats.body.data?.totals))

assert((await a.client.request('GET', `/api/files/${file}`)).status === 200, 'A can open the screenshot')
assert((await b.client.request('GET', `/api/files/${file}`)).status === 200, 'B (same game) can open the screenshot')
assert((await new Client().request('GET', `/api/files/${file}`)).status === 401, 'an anonymous visitor cannot open it')

const copiedCookie = a.client.cookie
const logout = await a.client.json('POST', '/api/auth/logout')
assert(logout.status === 200, 'A signs out')
const replay = await fetch(`${BASE}/api/auth/me`, { headers: { cookie: copiedCookie } })
assert(replay.status === 401, 'the signed-out token, replayed by hand, is refused')

for (const l of [listenerA, listenerB]) l.socket.close()
console.log(`SMOKE PASSED (${steps} checks)`)
