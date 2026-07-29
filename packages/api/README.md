# @valet/api

The Valet product server. One Node process hosts the Hono routes and
WebSocket, better-auth, the `EngineHost` around `@valet/engine`, the
`ChannelHost` (Telegram ingress), the plugin registry, the workflow run
host, the observability bootstrap, and the `valet` CLI. The compiled
single binary also embeds the web client's static build and migrations.

This is **not** the Cloudflare worker. The frozen legacy worker lives at
`packages/worker`.

## Run it

Requirements: a Docker daemon (default sandbox backend) and
`ANTHROPIC_API_KEY` in your environment.

```bash
make dev-local                          # api on :8788 + web on :5173
# or this package alone:
ANTHROPIC_API_KEY=sk-ant-... pnpm --filter @valet/api dev
```

## Where things live

| Area | Path |
|------|------|
| Routes | `src/routes/`, mounted in `src/app.ts` |
| Wire types (shared with the web client) | `src/wire/types.ts`, exported as `@valet/api/wire` |
| Engine wiring | `src/engine/` (`EngineHost`, wire bridge, workspace prep) |
| Providers (store, sandbox, blobs, telemetry) | `src/providers/` |
| Auth (better-auth + middleware ladder) | `src/auth/`, `src/middleware/auth.ts` |
| Plugin registry (generated) | `src/plugins/registry.gen.ts` (`make generate-registries`) |
| App schema (Drizzle) | `src/schema/index.ts`, migrations in `migrations/pg/` |
| CLI | `src/cli/` — command modules export pure `run*` functions |
| Observability | `src/observability/` (OTel bootstrap, HTTP middleware, traced store) |

## Key references

- Endpoint map: [`docs/api-reference.md`](../../docs/api-reference.md).
- Architecture: [`docs/architecture.md`](../../docs/architecture.md).
- Environment variables:
  [`docs/environment-variables.md`](../../docs/environment-variables.md).
- CLI: [`docs/cli.md`](../../docs/cli.md).

## Auth

Real auth activates when `BETTER_AUTH_SECRET` is set. Without it, set
`VALET_LOCAL_AUTH=1` for a stub local-dev identity — otherwise `/api/*`
routes 401. The middleware ladder (internal, sandbox token, cookie,
API key, stub) is documented in
[`docs/security-model.md`](../../docs/security-model.md).

## Storage

Postgres, either embedded or real. When `DATABASE_URL` is set, the server
connects via `pg.Pool`. When it is unset, the server boots embedded PGlite
at `VALET_PG_DATA_DIR` (default `~/.valet/pg/`). Two schema sets coexist
in one database:

- App schema: `packages/api/migrations/pg/0000_app.sql` (+ the Drizzle
  schema in `src/schema/index.ts`).
- Engine schema: `packages/store-postgres/migrations/pg/0000_engine.sql`.

`buildNodeProviders` runs both migration sets at boot. Pre-1.0, both are
single `0000` files edited in place — see CLAUDE.md for the mandatory
data-dir reset after a schema change.

## Tests

```bash
pnpm --filter @valet/api test        # unit + fixture suites
make smoke-session                   # real Anthropic + Docker round trip
make e2e                             # the full validation scorecard
```
