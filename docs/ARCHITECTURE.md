# Architecture

Ludo Arena is a private, admin-run platform for a Ludo group: players ping each other, play on Ludo King,
confirm the result, and the platform settles balances and keeps the ledger. `SPEC.md` is the product
spec; this file explains how the code is organised, why, and what the box can take.

## Shape of the system

```
browser ──https──> Cloudflare ──tunnel──> 127.0.0.1:5867 ──> app container :4002 (Express + socket.io) ──> Postgres 16
                                                                 │  static client bundle, /api, /socket.io
                                                                 └── uploads volume (screenshots)
```

* **One origin.** The page, `/api` and `/socket.io` are served by the same Express process, so the
  session cookie, CORS and the websocket need no special cases. In development Vite proxies `/api` and
  `/socket.io` to the server so the browser sees the same single origin.
* **Tunnel contract.** The container listens on 4002; `docker-compose.prod.yml` publishes it as
  `127.0.0.1:5867`. Nothing else is exposed.
* **No nginx edge (decision).** The CRM puts nginx in front of its API for static caching, compression,
  limits and a second hop of header hygiene. Here those jobs are already done: Cloudflare compresses and
  caches `/assets/*`, Express serves the hashed bundle with `immutable` caching and the SPA fallback, the
  security headers and CSP come from helmet, body and upload limits are enforced by `express.json` and
  multer, and keep-alive/header/request timeouts are set on the Node server. A second proxy would add a
  container, an upstream-address caveat and a websocket-upgrade configuration to maintain on a small box
  for no capability the app lacks. Revisit if the app is ever served without Cloudflare in front, or
  needs response compression or per-route buffering that Cloudflare does not provide.

## Server (`server/src`)

```
routes  ->  services (rules, transactions)  ->  lib (money, period, session, socket, prisma)  ->  config (env, limits, locale)
```

| Place | What lives there |
|---|---|
| `config/env.ts` | The only reader of `process.env`. Validates everything at start (names every problem, never a value): `NODE_ENV`, `DATABASE_URL`, `JWT_SECRET` (32+ chars, no placeholder), `PORT`, `CLIENT_URL` (https in production), `TRUST_PROXY`, `DB_POOL_MAX`. No default secret exists anywhere |
| `config/limits.ts`, `config/locale.ts` | Every tunable number (amount cap, commission tiers, timers, rate limits, page sizes) and the one timezone / currency / locale (`APP_TIMEZONE`, default `Asia/Kolkata`) |
| `lib/money.ts` | Money is integer cents in code and `NUMERIC(12,2)` in the database. Strict parsing (no NaN, no third decimal, no exponent), half-up commission with integer arithmetic only |
| `lib/period.ts` | The one date util: periods (`2026-09`, `2026`, `last7/30/90`, `this-month`, `last-month`, `this-year`, `all`, custom `from`/`to`) as half-open instant ranges whose edges are local midnights in `APP_TIMEZONE`; previous period; day/month spine. Golden-tested |
| `lib/session.ts`, `middleware/auth.ts` | httpOnly SameSite=Lax cookie (`Secure` in production) holding a signed token with a session id. Sessions are rows: every request checks that the row exists and has not expired and that the token carries the user's current `tokenVersion`. Signing out deletes the row (a copied token dies at once, that browser's socket is dropped); a password reset or a deleted account ends all of a user's sessions. The role comes from the database, not the token |
| `lib/socket.ts` | socket.io authenticates with the same cookie (never in JavaScript), re-checks it at connect, joins the socket to `user:<id>` (and `admin`) only; the server addresses rooms, clients cannot join or emit |
| `lib/errors.ts` | One error model: `HttpError` plus mapping of body-parser, multer and Prisma errors; an unexpected error is a fixed sentence plus a request id |
| `services/settlement.ts` | The only code that moves game money (see below) |
| `services/games.ts`, `services/pings.ts` | Voting, undo window, room code, screenshots; creating, answering and cancelling pings, all under row locks |
| `services/ledger.ts`, `statement*.ts` | Running balances (one function, used by the history screen and the PDF), statement data, pure shaping and the pdfkit template |
| `services/dashboard.ts` | Grouped SQL aggregates for one period, a 30 s cache keyed by period, dropped on settlement, deposit review, adjustment and game start |
| `middleware/` | request id and JSON request log, https redirect, same-origin writes, rate limits, idempotency, upload |
| `scripts/` | `migrate` (pre-start), `seed` (first admin), `admin-password` |

### Money and settlement

* **One settle function.** `planSettlement` is pure: it returns the ledger rows and the net change per
  player for Solo, Teams and 4-player games. `settleGame` applies it in one transaction that first locks
  the game row (`FOR UPDATE`), re-reads the state, checks each loser's credit limit under user row locks,
  and writes balances, ledger rows and the completed game together. Timer, admin resolve and retries can
  therefore race freely: exactly one pays.
* **Ledger rule.** `GAME_WIN` is the gross stake and `COMMISSION` a separate negative row, so a player's
  rows always sum to their balance change (tested per game, per player and in total; wins equal losses,
  commission is the only money leaving the players).
* **Undo window is data.** The agreed result is stored on the game (`settlesAt`, `settleWinnerId`,
  `settleSecondPlaceId`) and a 1 s sweeper pays due games, so a restart cannot lose a pending
  settlement. A loser who can no longer cover the stake sends the game to `DISPUTED` for the admin.
* **Open game = ACTIVE or PENDING_COMPLETION.** A player can be in one; DISPUTED does not count (an
  admin-owned state can take days). Admin may settle or void any unfinished game.
* **Lock order.** ping or game row first, then user rows in id order in one statement, so overlapping
  transactions queue instead of deadlocking. Transactions are short and capped at 10 s; statements at
  10 s; the pool is 8 connections.
* **Idempotency.** `Idempotency-Key` on ping, deposit, balance adjustment and player create: the first
  request runs, a retry gets the stored answer, a concurrent twin gets 409. Votes, done, room code and
  screenshots are protected by state claims instead.

### Uploads

multer streams to `uploads/.incoming`, the first bytes are sniffed (JPEG, PNG, WebP; the client type is
only a hint), the file is hashed and moved under a random name only after every other validation passed,
and the temp file is removed when the response ends. Files are private: `GET /api/files/:name` needs a
session and ownership (admin, the depositor, or a player of that game). A deposit screenshot hash is
unique, so one proof cannot back two requests. Limits: 10 MB per file, 5 screenshots per player per game,
30 multipart requests per user per 10 minutes.

### Network, addresses and limits

Cloudflare appends the visitor's address to `X-Forwarded-For`; cloudflared adds nothing; so with
`TRUST_PROXY=1` the rightmost entry is the visitor, and a client-forged prefix is ignored (tested).
`CF-Connecting-IP` is not used: it is just a header unless the origin is reachable only through
Cloudflare, and the hop count is explicit, validated and testable. Health checks and the tunnel's local
probe carry no `X-Forwarded-Proto`, so the http-to-https redirect never touches them.

Limits: login failures only (10 per address and 20 per account name per 15 min; correct logins are never
counted), 600 API requests per minute per address, uploads and statements per user.

## Database and migrations

Prisma migrations are committed (`server/prisma/migrations`). `0001_init` is the schema the first live
image created with `db push`; `0002` makes money exact and adds the settlement state, indexes and CHECK
constraints. The container entrypoint runs `migrate.js` then `seed.js` and only then the app; any failure
stops the start. `migrate.js` baselines a database that has the tables but no migration history (the
first live database) by marking `0001_init` applied, then runs `prisma migrate deploy`. `db push` is not
used anywhere.

## Admin credentials

The first admin is created from `ADMIN_USERNAME` and `ADMIN_PASSWORD` only when no admin exists; the seed
never changes an existing admin. To change the password (this also signs out every session of that
account, sockets included):

```bash
docker compose -p <project> -f docker-compose.prod.yml exec app node dist/scripts/admin-password.js
```

It asks for the new password at the prompt (not echoed) or reads it from standard input; set
`ADMIN_USERNAME` in the command's environment when there is more than one admin. An admin changes a
player's password from the Players screen; that signs the player out everywhere.

## API notes

* Success `{ "data": … }`, failure `{ "error": "sentence" }` (plus `requestId` on a 500).
* Lists accept `page` and `limit` (max 200).
* `GET /api/admin/stats`, `/api/admin/games`, `/api/admin/transactions` take `period=` or `from=&to=`
  (inclusive local dates, at most 366 days); bad values are a 400. Stats add `compare=0` to skip the
  previous-period comparison and return `period`, `totals`, `previous`, `chart` (a full day or month
  spine), `topPlayers`, live figures and the server's current month.
* `GET /api/players/:id/statement.pdf?period=…|from=&to=` returns `application/pdf` as an attachment;
  the player themself or the admin only; one export at a time per user (429), 10 per 10 minutes, at most
  3000 ledger rows (422 beyond that).
* `GET /api/players/:id/transactions` returns the newest 200 entries, each with `balanceAfter`.
* `GET /api/ready` checks the database and turns 503 while shutting down; `GET /api/health` is liveness.

## Client (`client/src`)

Vue 3 + Pinia + Vue Router, Tailwind. Code-split by route (the admin screens load only for the admin).

| Place | What lives there |
|---|---|
| `lib/api.ts` | One axios instance (same origin, 20 s timeout), idempotency keys, 401 hook |
| `lib/errors.ts`, `lib/format.ts`, `lib/period.ts` | Plain-language errors, amount/date/label formatting, period parameters kept in the URL |
| `lib/socket.ts` | Cookie-authenticated socket, handlers attached once, a jittered refetch after every reconnect |
| `components/Modal.vue` | The only dialog: bottom sheet on phones (dvh, sticky actions above the safe area), centred card from `sm`, Escape, focus handling, scroll lock |
| `components/StateBlock.vue` | Loading, error with retry, empty: every list uses it |
| `components/PeriodPicker.vue`, `StatementButton.vue`, `SessionExpiredModal.vue`, `PasswordInput.vue` | Period control, PDF export, in-place re-sign-in after a 401, show/hide password |

Mobile rules (style.css): `.page` padding, `min-w-0` + `truncate` on every flex child that holds user
text, `.amount` (mono, tabular, no wrap), one badge/tag/avatar style, 44 px hit areas on touch screens,
tables become cards below `md`, `dvh` instead of `vh`. Fonts are self-hosted. No storage holds secrets;
`localStorage` keeps only the admin sidebar state.

## Contract between server and client

`contracts/api-shapes.json` lists the shape of every endpoint and socket event the client consumes, and
`contracts/shape.ts` checks a value against it. The server's `contract.test.ts` drives a whole game, a
deposit review and the dashboard through the real API and sockets and asserts every answer against that
file; the client validates the answers it depends on at run time (`lib/contract.ts`) and shows an error
state with a plain sentence when one does not match. Change a payload and the file in the same commit;
a mismatch fails the server test, and in the browser it can no longer produce a blank page.

## Testing and gates

`make check` builds the `check` image for linux/amd64 and runs, against a throw-away Postgres:
server lint (typed ESLint with `no-floating-promises`), `tsc`, 190+ server tests (migrations applied by the
test setup; concurrency, money conservation, auth, sockets, uploads, period golden tables, statements),
client lint, `vue-tsc`, client tests, and both production builds. `make smoke` runs the production image as
shipped (non-root, read-only filesystem, dropped capabilities) through a scripted game from ping to
settlement over HTTP and sockets, the PDF, the private files, and a SIGTERM stop. `scripts/load.sh` is the
repeatable load run described below.

## Capacity

CAPACITY_PLACEHOLDER
