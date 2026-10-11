<div align="center">
  <img src="client/public/favicon.svg" alt="Ludo Arena mark" width="88" height="84">
  <h1>Ludo Arena</h1>
  <p><strong>Every match, accounted for.</strong></p>
  <p>A private, self-hosted hub for coordinating Ludo games and keeping a clear, shared ledger.</p>
  <p>
    <img src="https://img.shields.io/badge/self--hosted-101018?style=flat-square&logo=docker&logoColor=white" alt="Self-hosted">
    <img src="https://img.shields.io/badge/Vue_3-101018?style=flat-square&logo=vuedotjs&logoColor=42b883" alt="Vue 3">
    <img src="https://img.shields.io/badge/TypeScript-101018?style=flat-square&logo=typescript&logoColor=3178c6" alt="TypeScript">
    <img src="https://img.shields.io/badge/PostgreSQL-101018?style=flat-square&logo=postgresql&logoColor=4169e1" alt="PostgreSQL">
    <img src="https://img.shields.io/badge/license-MIT-101018?style=flat-square" alt="MIT License">
  </p>
</div>

---

## At a glance

Ludo Arena gives a private Ludo group one place to find players, arrange a match, confirm its result, and keep balances and game history in sync. Players coordinate live; an administrator manages membership, reviews exceptions, and has a complete view of the ledger.

**This is a coordination and accounting platform, not a Ludo game or payment processor.** Players play in Ludo King (or another agreed game), then record and confirm the outcome here. The group controls how balances are used outside the platform.

## What it does

- **Coordinate games:** send a direct or group ping, see live player availability, and share a Ludo King room code.
- **Confirm results together:** collect each player's result confirmation and screenshot evidence; send conflicting results to an administrator.
- **Settle and audit:** record game winnings and commission as explicit ledger entries, with balances and history derived from those records.
- **Manage the group:** administer player accounts, deposits, balance adjustments, games, and disputes.
- **Stay in sync:** update presence, pings, and game status over Socket.IO without polling the page.
- **Review activity:** view dashboards and date-filtered statements, including downloadable PDF statements.

## How a match works

1. A player pings one or more group members with a game type and stake.
2. Players accept; the platform creates a game and notifies participants.
3. The host shares the room code and everyone plays in Ludo King.
4. Players mark the match done, upload evidence, and agree on the result.
5. The platform settles an agreed result once. Disagreements or settlement issues go to the administrator.

## Built with

| Area | Technology |
| --- | --- |
| Web app | Vue 3, TypeScript, Vite, Pinia, Vue Router, Tailwind CSS |
| API and real-time | Node.js, Express, TypeScript, Socket.IO |
| Data | PostgreSQL, Prisma migrations |
| Documents | PDFKit |
| Local and production runtime | Docker Compose |

## Run locally

### Requirements

- Docker Engine with the Docker Compose plugin
- GNU Make

The development stack runs PostgreSQL, the API, and the Vite client in containers. It binds the client to `127.0.0.1:5867`; the API and database are reached through the local Compose network.

```sh
git clone https://github.com/PoisedDok/LudoArena.git
cd LudoArena
make env
make up
```

Open **http://localhost:5867**. `make env` creates a local `.env` containing fresh secrets and the first administrator's credentials; keep that file private and retrieve the credentials locally when you need them. There are no default credentials.

```sh
make down   # stop the development stack; retain its data volumes
```

`make clean` also removes this project's Compose volumes and their data. Use it only when you intentionally want to delete local database and upload data.

## Configuration

`make env` is the recommended way to prepare development configuration. It refuses to overwrite an existing `.env` and generates the database password, JWT secret, and initial admin password locally.

For production, start with [`.env.prod.example`](.env.prod.example) and provide real, unique values in a private `.env.prod` file. Set `POSTGRES_PASSWORD`, `JWT_SECRET` (at least 32 characters), `ADMIN_USERNAME`, and `ADMIN_PASSWORD`; set `CLIENT_URL` to the public HTTPS origin. Optional settings include `APP_TIMEZONE`, `TRUST_PROXY`, and `DB_POOL_MAX`. **Never commit `.env`, `.env.prod`, or other populated environment files.**

The application validates required configuration on startup and does not provide fallback secrets. The repository ignores local environment files while retaining the checked-in example templates.

## Production image

The production Compose configuration expects the `ludo-arena:prod` image to be available to Docker. Build it for the target device's architecture (the provided production build targets `linux/amd64`), then prepare a private `.env.prod` and start the stack:

```sh
docker build --platform linux/amd64 --target production -t ludo-arena:prod .
docker compose -p ludo-arena -f docker-compose.prod.yml --env-file .env.prod up -d --wait
```

The app is published on `127.0.0.1:5867` for use behind a trusted HTTPS reverse proxy or tunnel. PostgreSQL is not published to the host. Persistent database and upload data live in named Docker volumes. Review [`docker-compose.prod.yml`](docker-compose.prod.yml) and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) before exposing a deployment; configure `TRUST_PROXY` only for the actual trusted proxy topology.

## Checks

The project check runs linting, type checks, server and client tests, and production builds:

```sh
make check
```

This target uses Docker Compose and a temporary test database. The smoke test builds and starts the production image against a disposable database, then exercises an end-to-end game flow:

```sh
make smoke
```

For workspace-level commands, `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build` are also available after dependencies have been installed.

## Repository map

```text
client/                    Vue application
server/                    Express API, services, and Prisma schema/migrations
contracts/                 Shared API shape definitions
docs/                      Product specification and architecture notes
scripts/                   End-to-end smoke and load scripts
docker-compose*.yml        Development, production, and test stacks
```

## Design and security notes

- The browser, API, and websocket use one origin; the development Vite server proxies API and socket traffic.
- Authentication uses an `httpOnly` session cookie; role and session validity are checked server-side.
- Game settlement is transactional and idempotent, and ledger entries preserve an auditable balance history.
- Uploads are validated, stored under generated names, and served only to authorized participants.
- Production runs the app with a read-only root filesystem, dropped capabilities, and loopback-only host binding.
- Schema changes are managed as committed Prisma migrations; the production entrypoint migrates before starting the app.

For implementation details and operational constraints, see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`docs/SPEC.md`](docs/SPEC.md).

## License

This project is licensed under the [MIT License](LICENSE). Bundled Noto Sans font files retain the terms of the included SIL Open Font License notice.
