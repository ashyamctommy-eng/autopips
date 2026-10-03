# Autopipsz

An imported managed-trading platform with public information, client accounts,
identity verification, trading workspaces, settlements, and a staff console.

## Run and verify

- Web preview: managed workflow `artifacts/autopips: web`.
- HTTP API: managed workflow `artifacts/api-server: API Server`.
- Realtime/financial worker: managed workflow `artifacts/api-server: Trading Worker`.
  Start only after the original service configuration and database are ready.
- Backend tests: `pnpm --filter @workspace/api-server test`.
- Adapter checks independent of service setup:
  `pnpm --filter @workspace/api-server exec vitest run tests/migration-http.test.ts`.
- Prisma generation is part of the backend build; it does not apply migrations.

## Structure

- `artifacts/autopips`: Vite React frontend, retaining original pages, components,
  Tailwind 3 styling and themes. Its router replaces Next file-based routing.
- `artifacts/api-server/src/imported`: original service layer and API handlers.
- `artifacts/api-server/src/migration-api.ts`: Express request adapter and a closed,
  authorized read bridge for formerly server-rendered page data.
- `artifacts/api-server/prisma`: original Prisma schema and migration history.
- `.migration-backup`: original source reference; dependency manifests/lockfile
  are security-updated independently from the active pnpm workspace.
- Existing `lib/*` and mockup packages are retained scaffold packages.

## Service configuration

Required backend secrets: `JWT_SECRET`, `CREDENTIAL_ENCRYPTION_KEY`,
`WS_INTERNAL_TOKEN`. The user requires `EXECUTION_MODE=internal`; NOWPayments and
Deriv credentials are optional at boot in this mode, not simulated. Missing
provider credentials must refuse provider operations, never credit fake funds,
invent quotes, or accept unsigned payment callbacks. Broker mode continues to
require `NOWPAYMENTS_API_KEY`, `NOWPAYMENTS_IPN_SECRET`, and `DERIV_APP_ID`.
The user requires external payments and broker account execution disabled in
internal mode even when credentials are supplied. Public market data is separate:
use Twelve Data for supported history and Deriv's public feed where needed.
`REDIS_URL` is a non-secret configuration set to `redis://127.0.0.1:6379`.
The `Autopipsz Local Redis` workflow runs the Nix-provided Redis server on
loopback only, with append-only persistence under the gitignored `.cache/`
directory. Published startup uses a separate supervised script: the API starts
Redis, and the worker waits for Redis readiness. Use Reserved VM rather than
Autoscale for the continuous worker and single-instance local coordination.
Published Redis storage is ephemeral; Postgres remains the durable ledger.
The app connects only to Replit's runtime-managed `DATABASE_URL`; it has no
external database URL override. An account API token (`DERIV_API_TOKEN`) is
optional for public data but required for authenticated broker trading.

Keep the existing encryption key when using original data: changing it makes
encrypted broker credentials, KYC files, and settings unreadable.

## Migration constraints

- Preserve original routes, design, financial arithmetic, role checks and session
  semantics. Do not redesign or add demo balances to make the preview look full.
- Keep Prisma and the original schema. Do not replace it with the scaffold's
  Drizzle schema or migrate existing financial data without user authorization.
- Do not run migrations, seed accounts, or enable the trading worker against an
  existing database without confirming the intended target.
- Development can serve public pages during setup; unavailable backend operations
  explicitly return 503. Production refuses to start with missing configuration.
- Original SQL/provider integration tests need the configured, migrated database
  and external services; a reachable empty database is not sufficient.
- The frontend uses same-origin `/api` and `/ws` paths. Proxy routing includes
  websocket transport paths; no hardcoded development hosts are needed.

## Database choice

The user chose a fresh Replit database rather than reconnecting or importing the
original database. Keep accounts and financial records empty until real user
actions populate them. Do not restore original data or seed demonstration money.

The user requires zero Railway dependencies: run Redis locally in the Repl and
use native Replit PostgreSQL. Do not add Railway connections.
