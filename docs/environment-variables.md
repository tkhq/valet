# Environment Variables

All variables are read by the `@valet/api` server process unless noted. The
`valet` CLI resolves settings with precedence flag > env >
`~/.valet/config.json` > default.

## Core

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Anthropic key for the agent loop. The server exits without it. You can add org-level LLM providers in the UI |
| `PORT` | No | HTTP port (default `8787`. `make dev-local` sets `8788`) |
| `DATABASE_URL` | No | Postgres connection string. Set → node-postgres. Unset → embedded PGlite under the data dir |
| `VALET_DATA_DIR` | No | Data root (default `~/.valet`): config, PGlite, blobs, serve.lock |
| `VALET_PG_DATA_DIR` / `VALET_BLOBS_DIR` | No | Override the PGlite and blob-store locations individually |
| `VALET_ENCRYPTION_KEY` | Prod | AES-256-GCM key for credentials at rest (warned if unset) |
| `VALET_PLUGINS` | No | Extra plugin module specifiers to load beyond the bundled registry |
| `OPENAI_API_KEY` | No | Fallback OpenAI key |

## Auth

Real auth activates when `BETTER_AUTH_SECRET` is set. Otherwise the local
stub applies. Provider variable pairs are all-or-none.

| Variable | Description |
|----------|-------------|
| `BETTER_AUTH_SECRET` | Enables better-auth (email/password + configured providers) |
| `BETTER_AUTH_URL` | Public base URL (default `http://localhost:8788`) |
| `AUTH_TRUSTED_ORIGINS` | Extra CORS/trusted origins (`http://localhost:5173` is always included) |
| `AUTH_ALLOWED_EMAIL_DOMAINS` | Comma-separated signup domain allowlist |
| `AUTH_OIDC_ISSUER` / `AUTH_OIDC_CLIENT_ID` / `AUTH_OIDC_CLIENT_SECRET` | Generic OIDC SSO (e.g. Keycloak). Optional: `AUTH_OIDC_NAME`, `AUTH_OIDC_DOMAIN` |
| `AUTH_GOOGLE_CLIENT_ID` / `AUTH_GOOGLE_CLIENT_SECRET` | Google social login |
| `AUTH_GITHUB_CLIENT_ID` / `AUTH_GITHUB_CLIENT_SECRET` | GitHub social login |
| `VALET_LOCAL_AUTH` | `1` → stub identity for local dev (only when real auth is not configured) |
| `VALET_SANDBOX_JWT_MASTER` | Master key for per-session sandbox gateway JWT secrets (falls back to `BETTER_AUTH_SECRET`) |
| `VALET_INTERNAL_TOKEN` | Token for the server's internal self-calls (generated if unset) |

## Sandboxes

| Variable | Description |
|----------|-------------|
| `VALET_SANDBOX_BACKEND` | `docker` (default) \| `local` \| `kubernetes` |
| `VALET_SANDBOX_IMAGE` | Sandbox image ref (required for kubernetes; docker defaults to `node:20-bookworm`) |
| `VALET_SANDBOX_IDLE_MINUTES` | Idle-hibernation window (default `30`, `0` disables). Only effective on backends with hibernation (kubernetes) |
| `VALET_SANDBOX_NAMESPACE` | Kubernetes namespace for Sandbox CRs |
| `VALET_SANDBOX_IMAGE_PULL_SECRET` | Image pull secret name (kubernetes) |
| `VALET_KUBE_CONTEXT` | kubectl context (required when running out-of-cluster) |
| `VALET_SANDBOX_API_URL` | URL sandboxes use to call back into the API (defaults to the auth base URL) |

Inside each sandbox, the provider injects: `VALET_SANDBOX_TOKEN`,
`VALET_API_URL`, `VALET_SANDBOX_JWT_SECRET`, `VALET_SESSION_ID`,
`VALET_SANDBOX_PROFILE`.

## Channels

| Variable | Description |
|----------|-------------|
| `VALET_PUBLIC_URL` | Public URL for channel webhooks. Set (or a public `BETTER_AUTH_URL`) → webhook mode. Unset → long-poll |

## CLI

| Variable | Description |
|----------|-------------|
| `VALET_INSTANCE` | Named instance profile to target (client subcommands) |
| `VALET_DATA_DIR` | Also locates `~/.valet/config.json` for the CLI |

## Test-only

`VALET_TEST_AUTH_HEADER` (enables `x-valet-test-user-id` impersonation — never
set in dev targets or `.env`), `VALET_SKIP_DOCKER_TESTS`, `TEST_DATABASE_URL`,
`TELEGRAM_TEST_BOT_TOKEN` / `TELEGRAM_TEST_CHAT_ID`, and the
`VALET_GITHUB_LIVE_*` live-App test variables.
