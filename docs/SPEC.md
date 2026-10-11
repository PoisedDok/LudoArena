# Spec: Ludo Arena Platform

## Objective

A private admin-managed platform for a Ludo gaming group. The group runs real-money or credit-based games between its members. The platform replaces manual WhatsApp accounting and game coordination.

**Primary users:**
- **Admin** (1 person): runs the group, controls everything
- **Players** (group members): coordinate games, track their balance

**Success looks like:**
- Admin never manually tracks who played who or what the balance is
- Players can set up games in under a minute
- Every game has an audit trail (who played, stake, winner, screenshot proof)
- No WhatsApp needed to coordinate games within the group

---

## Tech Stack

| Layer | Choice | Reason |
|---|---|---|
| Frontend | Vue 3 + Vite + TypeScript | Light, fast, DX |
| State | Pinia | Simple, TS-friendly |
| Routing | Vue Router 4 | Standard |
| Styling | Tailwind CSS v3 | Utility-first, no overhead |
| Backend | Express + TypeScript | Lean, familiar |
| ORM | Prisma | Type-safe, great migrations |
| Database | PostgreSQL | Relational, reliable |
| Real-time | Socket.io | Pings, status updates |
| Auth | JWT (httpOnly cookies) | Stateless, secure |
| Uploads | Multer → local volume | Simple, docker-mounted |
| Container | Docker + docker-compose | 2 services: app + postgres |

---

## Commands

```bash
make env        # writes .env with freshly generated secrets (admin username and password included)
make up         # dev stack: postgres + server + client on http://localhost:5867
make down
make check      # lint, typecheck, server tests on real Postgres, client tests, production build
```

There are no default credentials: the admin is created on first start from ADMIN_USERNAME and
ADMIN_PASSWORD, and the server refuses to start without a real JWT_SECRET. Players are created by the
admin at /admin/players. Schema changes go through Prisma migrations (`server/prisma/migrations`), never
`db push`. See docs/ARCHITECTURE.md.

> Ports: server **4002** (published as 127.0.0.1:5867 in production), dev client **5867**. The database
> is reachable only inside the compose network.

---

## Project Structure

```
ludo-platform/
├── client/                  # Vue 3 + Vite frontend
│   ├── src/
│   │   ├── views/
│   │   │   ├── LoginView.vue
│   │   │   ├── player/
│   │   │   │   ├── PlayerLayout.vue
│   │   │   │   ├── DashboardView.vue
│   │   │   │   ├── GameView.vue
│   │   │   │   └── TransactionsView.vue
│   │   │   └── admin/
│   │   │       ├── AdminLayout.vue
│   │   │       ├── AdminDashboardView.vue  # stats cards + dual charts + recent games
│   │   │       ├── AdminGamesView.vue      # filterable table + resolve modal
│   │   │       ├── AdminPlayersView.vue    # player table + balance/edit/tx modals
│   │   │       └── AdminTransactionsView.vue  # full ledger, filterable
│   │   ├── stores/          # auth.ts, players.ts
│   │   ├── router/index.ts  # role-based guards + redirect
│   │   └── lib/             # api.ts (axios), socket.ts
│   └── vite.config.ts       # port 5867
│
├── server/
│   ├── src/
│   │   ├── routes/          # auth, players, pings, games, admin
│   │   ├── middleware/       # requireAuth, requireAdmin, upload (MIME-typed)
│   │   ├── lib/              # prisma.ts (PrismaPg adapter), jwt.ts, socket.ts, jobs.ts
│   │   ├── index.ts
│   │   └── seed.ts
│   ├── prisma/
│   │   ├── schema.prisma
│   │   └── prisma.config.ts  # CLI datasource (Prisma 7)
│   └── generated/prisma/     # generated client
│
├── uploads/                  # Screenshot storage (docker volume → /app/server/uploads)
├── docs/
├── docker-compose.dev.yml    # postgres + server + client dev services
├── Dockerfile.dev            # multi-stage: base / server-dev / client-dev
├── .dockerignore
└── package.json              # npm workspaces root (lock file here)
```

---

## Feature Spec

### F1: Authentication
- Single `/login` page for all users (admin + players)
- JWT stored in httpOnly cookie (7-day expiry)
- Role-based routing: admin → `/admin`, player → `/`
- Logout clears cookie and redirects to login
- Players are created by admin only (no self-registration)

### F2: Player Management (Admin)
- Admin can create players (username, email, password, initial balance)
- Admin can edit player: username, email, reset password, balance (manual credit/debit), creditLimit, spendLimit
- Admin can deactivate/reactivate players (soft disable)
- Admin sees all players with: username, balance, creditLimit, spendLimit, gamesPlayed, lastActive

### F3: Active Status
- Player has a single toggle on their dashboard: "I'm Active" / "Go Offline"
- Toggle updates `user.isActive` in DB and broadcasts via Socket.io to all connected clients
- When player disconnects (socket close), their status is NOT auto-set to inactive (they must explicitly toggle — some people use mobile)
- Active status resets to `false` on server restart (safety valve via seed/migration default)

### F4: Player Discovery
- Players can see a list of all other group members with their active/inactive status
- Live status updates via Socket.io (green dot pulsing = active, grey = inactive)
- Players can see each other's public info: username, status (NOT balance)
- Balance is only visible to the player themselves and admin

### F5: Ping System (Direct + Broadcast)

**Direct ping:** Player A selects Player B and sends a 1v1 game request only.

**Broadcast ping:** Player A sends a game request to ALL currently active players. Anyone can accept.

**Ping includes:**
- Game type: `ONE_V_ONE` (Solo), `TWO_V_TWO` (Teams), `FOUR_PLAYER` (4v2)
- Stake amount (numeric, validated against sender's spendLimit and recipient's creditLimit)
- Optional message
- Optional Ludo King room code (appended as `[Room: CODE]` in message)
- Expiry: 10 minutes (auto-expire if no response)

**Responses:**
- Recipient sees incoming ping as a notification/modal
- Can Accept or Decline
- For Teams (2v2): need 3 others to accept before game starts
- For 4v2: game starts when 3 others have accepted (total 4 players)
- For Solo: game starts when the 1 recipient accepts

**On acceptance (all required players accepted):**
- Game record created with a unique `internalRef` (6-char alphanumeric)
- All players notified via socket with game info
- Ping status set to `ACCEPTED`, game status set to `ACTIVE`

**Edge cases:**
- Sender can cancel their own pending broadcast ping
- Player already in an active game cannot send or accept new pings
- Direct ping is Solo only (ONE_V_ONE)

### F6: Game Flow

**This platform is a coordination and accounting layer only. The actual Ludo game is played on Ludo King. The platform does NOT generate room codes.**

**Active game:**
- When ping is accepted → game record created in the platform
- All players see a "Game in Progress" card: game type, stake, opponents
- A `Room Code` field shows "Waiting for host..." until initiator pastes Ludo King room code
- Initiator pastes room code → platform displays it to all players in real-time (no refresh needed)
- Players join Ludo King using that code

**Completion:**
- Any player clicks "Mark as Done" → game status → `PENDING_COMPLETION`
- All players upload a screenshot of the result
- All players confirm and select winner
- For 4v2: players also select 2nd place (separate dropdown, cannot be same as winner)
- Once ALL players confirm and agree → game `COMPLETED`, balances settled

**Winner conflict:**
- If players disagree on winner or 2nd place → game status → `DISPUTED`
- Admin resolves manually from the games page

### F7: Commission Rules (Global, Rule-Based)

Commission is calculated automatically based on game type and stake. There is no per-player commission setting.

#### Solo (ONE_V_ONE)
| Stake | Commission | Winner receives | Loser pays |
|---|---|---|---|
| ≤ 500 | 5% of stake | stake × 0.95 | stake |
| > 500 | 3% of stake | stake × 0.97 | stake |

Example (stake=200): Winner +190, Admin +10, Loser −200
Example (stake=1000): Winner +970, Admin +30, Loser −1000

#### Teams (TWO_V_TWO)
Same commission tiers as Solo, applied per winning player.

| Stake | Commission | Each winner receives | Each loser pays |
|---|---|---|---|
| ≤ 500 | 5% of stake | stake × 0.95 | stake |
| > 500 | 3% of stake | stake × 0.97 | stake |

Example (stake=300): Each winner +285, Admin +15 per winner (+30 total), Each loser −300

#### 4v2 (FOUR_PLAYER — 4 individual players)
Fixed rules regardless of stake amount:

| Place | Net change | Commission |
|---|---|---|
| 1st | +stake (full, no cut) | none |
| 2nd | +(stake × 0.90) | 10% of stake → admin |
| 3rd | −stake | none |
| 4th | −stake | none |

Example (stake=1000, 4 players, total pool=4000):
- 1st: wallet +1000 (their 1000 back + 1000 won = 2000 total, net +1000)
- 2nd: wallet +900 (their 1000 back − 100 = 900 net), Admin +100
- 3rd: −1000
- 4th: −1000
- Balanced: 4000 in = 1000 + 900 + 100 commission + 1000 + 1000 out ✓

**2nd place declared by players via self-report** (same confirmation flow as winner).

### F8: Balance System
- Balances are floats (can be negative)
- Admin sets `creditLimit` per player (max negative balance, e.g. -500)
- Admin sets `spendLimit` per player (max stake per game, e.g. 100)
- Transactions recorded for every balance change with type + description
- Players see their own balance + full transaction history ("My Games")
- Admin sees all players' balances and full ledger
- Balance validation: before accepting a ping, system checks creditLimit
- Commission recorded as separate `COMMISSION` transaction type (negative amount on winner)

### F9: Screenshot Upload
- After game is marked done, each player uploads 1 screenshot
- Accepted formats: JPEG, PNG, WEBP (max 10MB)
- Screenshots stored in `uploads/` (docker volume mapped to host)
- Admin and game players can view all screenshots for a game
- Required before result confirmation

### F10: Admin Dashboard ✅
- Summary cards: today's games, today's volume, active players now, disputed count
- Commission cards: total all-time commission + today's commission
- 30-day bar charts: volume (amber) + games count (green) with hover tooltips
- Recent games list (last 8), disputed alert badge with animated pulse
- Live broadcasts panel showing active broadcast pings with accept counts

### F11: Admin Player Management ✅
- Searchable player table (by username or email)
- Add player modal: username, email, password, initial balance, credit/spend limits
- Edit player modal: username, email, password, creditLimit, spendLimit (no commission field)
- Balance adjustment modal: amount (±), reason/description (audit trail)
- Transactions panel: per-player ledger in modal

### F12: Admin Games ✅
- Filterable by status (All / Active / Pending / Disputed / Completed)
- Paginated (20/page), click row for detail modal
- Dispute resolve: void game or select winner (+ 2nd place for 4v2)
- Live broadcasts section showing real-time accept counts

### F13: Admin Transactions ✅
- Full platform-wide ledger, filterable, paginated (25/page)
- Includes `COMMISSION` transaction type showing admin earnings

---

## Data Model Summary

```
User: id, username, email, passwordHash, role, balance, creditLimit, spendLimit, isActive
Ping: id, fromUserId, gameType, stake, message, status, expiresAt, isBroadcast
PingRecipient: id, pingId, userId, response
Game: id, internalRef, pingId, gameType, stake, status, winnerId, secondPlaceId, ludoRoomCode, createdAt, finishedAt
GamePlayer: id, gameId, userId, team, isDone, confirmedWinnerId, confirmedSecondPlaceId
Transaction: id, userId, amount, type, gameId, description, createdAt
Screenshot: id, gameId, userId, filename, uploadedAt
```

---

## Game Types

| Internal enum | Display name | Players | Commission |
|---|---|---|---|
| `ONE_V_ONE` | Solo | 2 | 5% (stake ≤500) / 3% (stake >500) |
| `TWO_V_TWO` | Teams | 4 (2v2) | 5% (stake ≤500) / 3% (stake >500) |
| `FOUR_PLAYER` | 4v2 | 4 (all individual) | Fixed: 10% of stake from 2nd place only |

---

## API Routes

```
POST   /api/auth/login
POST   /api/auth/logout
GET    /api/auth/me

GET    /api/players                     # all players (admin) or public list (player)
POST   /api/players                     # admin: create player
GET    /api/players/:id
PUT    /api/players/:id                 # admin: edit player
PATCH  /api/players/:id/active         # player: toggle own active status
PATCH  /api/players/:id/balance        # admin: manual balance adjustment

GET    /api/pings                       # player: pings sent/received
POST   /api/pings                       # create ping (direct or broadcast)
PATCH  /api/pings/:id/respond          # accept or decline
DELETE /api/pings/:id                  # sender cancels own broadcast

GET    /api/games                       # player: own games / admin: all games
GET    /api/games/:id
PATCH  /api/games/:id/done             # mark as done
PATCH  /api/games/:id/roomcode         # set Ludo King room code
POST   /api/games/:id/confirm          # confirm result + declare winner (+ 2nd for 4v2)
POST   /api/games/:id/screenshots      # upload screenshot

GET    /api/admin/stats                 # daily stats, commission totals
GET    /api/admin/broadcasts           # live broadcasts with accept counts
GET    /api/admin/transactions         # full ledger
GET    /api/admin/games                # all games with detail
PATCH  /api/admin/games/:id/resolve    # resolve disputed game
```

---

## Socket.io Events

```
# Server → Client
player:status              { userId, isActive }
ping:received              { ping, from }           # direct pings only
ping:broadcast_new         { ping }                 # new broadcast (all clients + admin)
ping:broadcast_update      { pingId, recipients }   # accept count changed
ping:broadcast_resolved    { pingId, status }       # accepted/expired/cancelled
ping:accepted              { pingId, game }
ping:declined              { pingId, byUserId }
ping:expired               { pingId }
game:roomcode              { gameId, ludoRoomCode }
game:done                  { gameId }
game:completed             { gameId, winnerId, balances }
game:disputed              { gameId }
balance:updated            { balance }
```

---

## UI/UX Design Language

- **Theme**: Dark. Premium gaming aesthetic. Refined, clean, serious money.
- **Palette**: 
  - Background: `#09090f` 
  - Surface: `#111118` 
  - Border: `#1e1e2a`
  - Accent: `#f59e0b` (amber/gold)
  - Active green: `#22c55e`
  - Inactive: `#4b5563`
  - Danger: `#ef4444`
  - Text: `#f1f5f9` / muted `#94a3b8`
- **Typography**: `DM Sans` (body, UI) + `Space Mono` (codes, numbers, balance)
- **Components**: Cards with subtle borders, smooth transitions (150ms ease), sharp premium feel
- **Active status**: Pulsing green dot (CSS animation)
- **Balance**: Always monospace, + is amber, - is red
- **Game code**: Large monospace, spaced out like `AB3-K7P`

---

## Boundaries

**Always:**
- Validate auth on every protected route
- Record a Transaction for every balance change (including admin adjustments)
- Check creditLimit before allowing game acceptance
- Check spendLimit before allowing ping creation
- Require screenshots before result confirmation
- Return consistent `{ data, error }` envelope from all API routes
- Commission is global/rule-based only — no per-player override

**Never:**
- Allow players to see other players' balances
- Allow players to edit their own balance
- Allow a game to complete without screenshot from all players
- Allow negative balance beyond creditLimit
- Expose passwordHash in any API response

---

## Success Criteria

- [x] Admin can create a player and they can log in
- [x] Player can toggle active status, others see it update in real-time
- [x] Player can send a broadcast ping; active players receive it and can accept
- [x] On acceptance, game code is shown to all participants
- [x] After game: all players upload screenshot, confirm winner, balances auto-update
- [x] Admin dashboard shows correct per-day stats and all games (dual charts, stat + commission cards)
- [x] Admin can manually adjust a player's balance with audit trail
- [x] All Docker containers start with `docker-compose -f docker-compose.dev.yml up --build`
- [x] No player can see another's balance
- [x] Role-based redirect: admin → `/admin`, player → `/`, already-authed → skip login
- [x] Admin transactions ledger with type + user filters
- [x] Disputed games resolvable inline from games page
- [x] Screenshot uploads: MIME-validated, stored in docker-mounted volume
- [x] Commission auto-calculated by rule (tier for Solo/Teams, fixed 10% 2nd-place for 4v2)
- [ ] 4v2 mode: 2nd place self-declared, correct payout with 10% admin cut

---

## Commission Examples (Reference)

| Game | Stake | Result | Winner net | 2nd net | Admin |
|---|---|---|---|---|---|
| Solo | 200 | ≤500 → 5% | +190 | — | +10 |
| Solo | 1000 | >500 → 3% | +970 | — | +30 |
| Teams | 300 | ≤500 → 5% | +285 each | — | +30 total |
| Teams | 600 | >500 → 3% | +582 each | — | +36 total |
| 4v2 | 1000 | fixed 10% on 2nd | +1000 | +900 | +100 |
