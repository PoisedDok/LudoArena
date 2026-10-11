<div align="center">
  <svg width="160" height="160" viewBox="0 0 160 160" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Ludo Arena premium mark">
    <defs>
      <linearGradient id="bgGlow" x1="24" y1="16" x2="130" y2="144" gradientUnits="userSpaceOnUse">
        <stop stop-color="#170F2E"/>
        <stop offset="0.52" stop-color="#0F152E"/>
        <stop offset="1" stop-color="#0A0F1A"/>
      </linearGradient>
      <linearGradient id="ringGlow" x1="32" y1="24" x2="128" y2="136" gradientUnits="userSpaceOnUse">
        <stop stop-color="#7C52FF"/>
        <stop offset="0.5" stop-color="#42D6FF"/>
        <stop offset="1" stop-color="#9BF7D8"/>
      </linearGradient>
      <linearGradient id="tileA" x1="33" y1="34" x2="104" y2="82" gradientUnits="userSpaceOnUse">
        <stop stop-color="#C0B8FF"/>
        <stop offset="1" stop-color="#7C52FF"/>
      </linearGradient>
      <linearGradient id="tileB" x1="56" y1="38" x2="124" y2="120" gradientUnits="userSpaceOnUse">
        <stop stop-color="#7EE7FF"/>
        <stop offset="1" stop-color="#2BBCEB"/>
      </linearGradient>
      <linearGradient id="tileC" x1="30" y1="98" x2="108" y2="144" gradientUnits="userSpaceOnUse">
        <stop stop-color="#FFE8A3"/>
        <stop offset="1" stop-color="#FFB84D"/>
      </linearGradient>
      <linearGradient id="tileD" x1="44" y1="64" x2="128" y2="134" gradientUnits="userSpaceOnUse">
        <stop stop-color="#FF9DC8"/>
        <stop offset="1" stop-color="#FF5F96"/>
      </linearGradient>
      <filter id="softGlow" x="-30%" y="-30%" width="160%" height="160%">
        <feGaussianBlur stdDeviation="8" result="blur"/>
        <feMerge>
          <feMergeNode in="blur"/>
          <feMergeNode in="SourceGraphic"/>
        </feMerge>
      </filter>
      <style>
        .pulse { animation: pulse 4.5s ease-in-out infinite; transform-origin: center; }
        .drift { animation: drift 6s ease-in-out infinite alternate; transform-origin: center; }
        .spin { animation: spin 16s linear infinite; transform-origin: center; }
        .shimmer { animation: shimmer 3s ease-in-out infinite; }
        @keyframes pulse {
          0%, 100% { transform: scale(0.96); opacity: 0.72; }
          50% { transform: scale(1.04); opacity: 1; }
        }
        @keyframes drift {
          0% { transform: translateY(0px); }
          100% { transform: translateY(-6px); }
        }
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        @keyframes shimmer {
          0%, 100% { opacity: 0.45; }
          50% { opacity: 1; }
        }
      </style>
    </defs>

    <rect x="10" y="10" width="140" height="140" rx="38" fill="url(#bgGlow)"/>
    <circle class="pulse" cx="80" cy="80" r="58" fill="url(#ringGlow)" opacity="0.18"/>
    <circle class="spin" cx="80" cy="80" r="58" stroke="url(#ringGlow)" stroke-width="2.2" opacity="0.8"/>

    <g class="drift">
      <path d="M80 30L118 58L80 130L42 58L80 30Z" fill="url(#tileA)" opacity="0.26"/>
      <path d="M80 30L118 58L80 130L42 58L80 30Z" stroke="rgba(255,255,255,0.38)" stroke-width="1.6"/>
      <path d="M80 42L103 61L80 112L57 61L80 42Z" fill="url(#tileA)" opacity="0.96"/>
      <path d="M126 80L94 102L80 130L80 80L126 80Z" fill="url(#tileB)" opacity="0.92"/>
      <path d="M80 80L34 80L80 130L80 80Z" fill="url(#tileC)" opacity="0.94"/>
      <path d="M80 80L80 30L42 58L80 80Z" fill="url(#tileD)" opacity="0.94"/>
      <circle cx="80" cy="80" r="14" fill="#F7F5FF" opacity="0.9"/>
      <circle cx="80" cy="80" r="8" fill="#111827" opacity="0.9"/>
    </g>

    <g filter="url(#softGlow)">
      <path d="M80 22C92 22 104 32 104 44C104 52 101 58 96 63L80 80L64 63C59 58 56 52 56 44C56 32 68 22 80 22Z" fill="url(#tileA)" opacity="0.9"/>
      <path d="M138 80C138 92 128 104 116 104C108 104 102 101 97 96L80 80L97 64C102 59 108 56 116 56C128 56 138 68 138 80Z" fill="url(#tileB)" opacity="0.9"/>
      <path d="M80 138C68 138 56 128 56 116C56 108 59 102 64 97L80 80L96 97C101 102 104 108 104 116C104 128 92 138 80 138Z" fill="url(#tileC)" opacity="0.9"/>
      <path d="M22 80C22 68 32 56 44 56C52 56 58 59 63 64L80 80L63 97C58 102 52 104 44 104C32 104 22 92 22 80Z" fill="url(#tileD)" opacity="0.9"/>
    </g>

    <g class="shimmer" opacity="0.7">
      <path d="M80 32L103 55L80 80L57 55L80 32Z" fill="none" stroke="rgba(255,255,255,0.85)" stroke-width="1.4"/>
      <path d="M80 80L104 105L80 128L56 105L80 80Z" fill="none" stroke="rgba(255,255,255,0.5)" stroke-width="1.2"/>
    </g>

    <circle cx="128" cy="42" r="3.5" fill="#D7F7FF" opacity="0.95"/>
    <circle cx="40" cy="118" r="4" fill="#FFD0E8" opacity="0.9"/>
    <circle cx="114" cy="116" r="3" fill="#D9E8FF" opacity="0.9"/>
  </svg>

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
