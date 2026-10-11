# Admin Commission Settings Plan

**Status:** Implemented and verified  
**Scope:** Editable commission rules, independently configured for each game type. No other application settings are included.

## Goal

Give admins one **Settings** page in the existing admin sidebar where they can view and edit commission rules for Solo (1v1), Teams (2v2), and Four-player (4-player). Keep the current commission behavior as the initial configuration. A saved change must affect games created after the change, never change the rules for a game already created.

## Existing behavior and project conventions

- Commission rules are constants in `server/src/config/limits.ts`.
- Solo and Teams currently share a stake-tier calculation in `server/src/lib/money.ts`: 5% for a stake up to and including 500, and 3% above 500. Teams charge the commission to each winning player.
- Four-player currently charges 10% of the stake to second place only. First, third, and fourth place pay no commission.
- `server/src/services/settlement.ts` constructs the ledger entries and is the settlement source of truth.
- The game row is created when a ping is accepted. This is the point at which the game’s commission rules must be captured.
- Admin pages use the nested `/admin` routes and sidebar in `client/src/router/index.ts` and `client/src/views/admin/AdminLayout.vue`. Existing screens use the shared Axios client, inline loading/error state, and shared `card`, `label`, `input`, and button styles.
- Admin APIs use `requireAdmin` in `server/src/routes/admin.ts`; responses are represented in `contracts/api-shapes.json` and exercised by server contract tests.
- Schema changes use committed Prisma migrations. The production startup applies migrations before serving traffic.
- The project release gates are `make check` (lint, typecheck, tests with Postgres, production builds) and `make smoke` (production-image end-to-end check). No GitHub Actions workflow was found in the inspected repository; this plan uses the existing project gates and does not add CI infrastructure.

## Decisions and boundaries

1. **Settings are per game type.** Solo and Teams each get their own tier threshold, lower/equal-threshold rate, and above-threshold rate. They start with identical values, but an admin can change one without changing the other. Four-player gets its own second-place commission rate.
2. **Changes are prospective.** Snapshot applicable rules onto the game when the game is created. Settlement reads that snapshot, including admin resolution of a disputed game. Settings edits never recalculate an existing game.
3. **Keep current non-configurable Four-player behavior.** First place and third/fourth place commission remain zero. The initial scope only makes the current second-place commission editable; it does not add other payout or placement settings.
4. **Only commission is editable in this page.** Do not add unrelated app, player, stake, payout, or game settings.
5. **Retain existing ledger behavior.** Continue recording commission as its existing separate `COMMISSION` transaction; do not rewrite historical ledger rows or past balances.
6. **Admins only.** Both the route and every settings endpoint must enforce the existing server-side admin authorization. Hiding the link in the UI is not authorization.

## Settings presented in the page

Show three distinct, clearly titled sections:

| Game type | Editable commission fields | Initial values |
|---|---|---|
| Solo (1v1) | Threshold stake; rate at or below threshold; rate above threshold | 500; 5%; 3% |
| Teams (2v2) | Threshold stake; rate at or below threshold; rate above threshold | 500; 5%; 3% |
| Four-player | Second-place commission rate | 10% |

Display that Solo/Teams apply the rate to each winner and that Four-player charges second place only. State visibly that changes apply to newly created games only. Do not imply that saving changes an in-progress game.

Rates are represented and calculated in integer basis points to preserve the server’s exact-money conventions. Stake threshold is represented in integer cents. The UI accepts a non-negative threshold with at most two decimal places and a percentage from 0% through 100% with at most two decimal places (whole basis points). Reject malformed, non-finite, negative, out-of-range, or over-precision values on the server; do not rely on client validation.

## Implementation plan

### 1. Persist current rules and introduce a migration

- Add one current commission configuration per game type, stored in Postgres and managed by Prisma.
- Store rates as integer basis points and the tier threshold as integer cents. Make the tier-only fields inapplicable to Four-player and the second-place-only field inapplicable to Solo/Teams; validate this shape at the API boundary.
- Include update time and admin attribution for changes. Keep an append-only change record with actor, timestamp, and before/after values so edits are auditable.
- Add a committed migration and initialize the three records with the exact current production defaults: Solo 500 / 5% / 3%, Teams 500 / 5% / 3%, Four-player second place 10%.
- Backfill existing game rows with the legacy rules during migration. This preserves settlements for active, pending, and disputed games created before the feature is deployed.
- Ensure a new installation receives the same defaults through the normal migration/seed path; seeding must remain repeatable and must not reset admin-edited settings on application restart.

### 2. Add an admin-only settings API

- Add a read endpoint returning all three typed settings records and an update endpoint for one game type.
- Use the existing admin router, validation helpers, error handling, no-store API behavior, and contract-test shape checks.
- Validate the complete input shape for that game type: required fields present, unsupported fields rejected or explicitly disallowed, rates in range and exact to a basis point, and threshold parsed exactly to cents.
- Update the current value and append its audit record in one database transaction. Attribute changes to the authenticated admin.
- Return the saved canonical values. Surface validation and database failures as API errors; do not return successful-looking defaults when settings cannot load.
- Extend `contracts/api-shapes.json` and its real-server contract coverage for both read and update responses.

### 3. Snapshot settings at game creation and use them for settlement

- Trace every path that creates a `Game`, including accepted direct and broadcast pings, and ensure every new game receives a complete snapshot for its `gameType`.
- Read the current configuration and create the game with its snapshot atomically, so concurrent admin edits and game creation cannot produce a partial or mixed snapshot. Define the transaction/locking behavior so a game is consistently classified as created under either the before-change or after-change rules.
- Store snapshot fields as typed database values rather than recomputing from current settings or storing unvalidated client-provided values.
- Change `planSettlement` and all settlement callers to use the game’s snapshot. Keep the pure plan function testable with explicit rules.
- Verify regular vote settlement, delayed settlement after the undo window, retry/sweep settlement, and admin resolution all use the same snapshot.
- Preserve the existing integer-cent rounding policy, team winner rules, separate ledger entries, and transaction idempotency.
- Backfilled games must have non-null snapshots equivalent to the old hardcoded rules before the new settlement code is deployed.

### 4. Add the Admin Settings page using existing UI patterns

- Add the lazy-loaded `/admin/settings` child route with the existing `ADMIN` parent guard.
- Add a sidebar item named **Settings** with a consistent icon, active state, collapsed-sidebar tooltip, and mobile navigation behavior.
- Build a responsive settings page in the existing admin visual language. Use the shared `card`, `label`, `input`, and button classes; provide accessible labels, field help text, and clear per-game headings.
- On page load, show the established loading state; on failure, show an actionable error and retry path. Do not display fabricated defaults as if they were loaded from the server.
- Keep edits local until Save. Disable duplicate submissions while saving; show the server error on failure and update the displayed saved values only after success.
- Clearly communicate the prospective-only effect before saving. Do not add unrelated settings, reset controls, player overrides, or game-history editing.

### 5. Test the behavior end to end

**Server/API and persistence**

- Non-admin and unauthenticated users cannot read or update settings.
- An admin can read each game type and update one without altering the other two.
- Invalid/missing fields, wrong fields for a game type, negative or over-100% rates, excess decimal precision, invalid thresholds, and malformed game types fail explicitly.
- Updates and audit records persist across application/database connections; repeated seed/startup does not overwrite them.
- Changes preserve actor and before/after audit data.

**Game creation and settlement**

- New Solo, Teams, and Four-player games snapshot their own current rule values.
- Changing a setting leaves already-created games (including pending and disputed games) on their original snapshot while subsequently created games use the new value.
- Verify threshold boundary behavior at exactly the threshold and one cent above, for Solo and Teams independently.
- Verify Teams charge each winning player, Four-player charges only second place, and first/third/fourth place remain unchanged.
- Verify zero commission, maximum valid rates, half-up integer-cent rounding, ledger reconciliation, and unchanged behavior for migrated legacy games.
- Exercise both player agreement and admin resolution (and, where applicable, settlement sweep/retry) against snapshots.

**Client**

- Verify the route/nav entry and page content for all three independent settings.
- Verify loading, load failure/retry, edit/save success, server-side validation failure, and save-in-progress behavior.
- Verify no non-commission controls are present.

### 6. Update documentation and API contracts

- Update the commission section in `docs/SPEC.md` to describe independent per-type settings, defaults, and future-games-only effect.
- Update `docs/ARCHITECTURE.md` to identify persisted settings, per-game snapshots, audit history, and the migration behavior.
- Keep `contracts/api-shapes.json` and its server contract tests in sync with the settings endpoints and any response fields changed by snapshots.
- Document the deployment implication: the committed migration backfills legacy games before the app starts using snapshot-based settlement.

### 7. Verify the repository release pipeline

- Run `make check` and fix failures introduced by this feature.
- Run `make smoke` to verify the production image applies migrations and can complete its end-to-end settlement path.
- Specifically verify a database with existing rows migrates successfully and its prior games retain legacy payout rules.
- Review the final diff for scope: commission settings only; no unrelated settings or changes to historical ledger entries.

## Acceptance criteria

- The admin sidebar contains a **Settings** item that opens an admin-only page.
- The page exposes exactly the three game-type commission configurations described above, with Solo and Teams independently editable.
- Settings load from and save to durable server storage; the server is authoritative and rejects invalid inputs.
- Each game settles using the commission snapshot captured at game creation, regardless of later settings edits or whether settlement is automatic or admin-triggered.
- Existing games are safely backfilled to the current legacy rules, with no change to historical transactions or balances.
- Changes are auditable and do not reset on restart or reseeding.
- API shape tests, backend behavior tests, client tests, `make check`, and `make smoke` pass.
- Documentation reflects the shipped behavior, and no non-commission setting has been introduced.

## Effort estimate

Estimated implementation effort: **8–12 engineering hours** (approximately 1–2 working days), excluding review/approval or deployment scheduling. This includes the migration/backfill, safe snapshot semantics, API/audit history, admin page, tests, documentation, and both repository release gates. No new paid infrastructure is expected.
