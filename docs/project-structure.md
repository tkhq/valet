# Project Structure

```
valet/
├── packages/
│   ├── api/                 # Product server: Hono routes + WS, better-auth,
│   │   └── src/             #   EngineHost, ChannelHost, plugin registry
│   │       ├── routes/      # Hono routers (sessions, messages, ws, org, ...)
│   │       ├── engine/      # EngineHost, wire bridge, session meta
│   │       ├── auth/        # better-auth config, sandbox tokens, MCP OAuth
│   │       ├── channels/    # ChannelHost (long-poll / webhook ingress)
│   │       ├── orchestrator/# Attention router, memory tools, persona
│   │       ├── plugins/     # registry.gen.ts + node_modules loader
│   │       ├── providers/   # Provider bundle assembly (store, sandbox, ...)
│   │       ├── schema/      # Drizzle schema (app tables)
│   │       ├── wire/        # Wire protocol types (shared with web)
│   │       └── cli/         # valet CLI (serve, send, chat, gates, mcp, ...)
│   ├── engine/              # Portable agent runtime (pi-agent-core loop,
│   │                        #   threads, durable submissions, decision gates)
│   ├── store-postgres/      # SessionStore + EventStream over Postgres
│   │   └── migrations/pg/   #   (PGlite dev, node-postgres prod)
│   ├── web/                 # Web client (Vite, React 19, TanStack Router)
│   │   └── src/
│   │       ├── api/         # Typed REST client + queries (@valet/api/wire)
│   │       ├── components/  # UI (session, tool renderers, settings, ...)
│   │       ├── routes/      # File-based routes (sessions, workflows, ...)
│   │       └── stores/      # Zustand (stream ingest, composer prefill)
│   ├── sandbox-docker/      # Sandbox provider: container + bind mount
│   ├── sandbox-kubernetes/  # Sandbox provider: Sandbox CRs (hibernation)
│   ├── sandbox-local/       # Sandbox provider: host fs/process (dev only)
│   ├── sandbox-gateway/     # In-sandbox JWT proxy (ttyd, code-server)
│   ├── plugin-*/            # Plugins: actions, triggers, skills, channels
│   ├── sdk/                 # Integration & channel SDK contracts
│   ├── shared/              # Shared types & errors
│   ├── client/, worker/, runner/  # LEGACY (Cloudflare stack, frozen)
├── backend/                 # LEGACY Modal Python backend (frozen)
├── docker/
│   ├── Dockerfile.sandbox-k8s   # v2 sandbox image (gateway, ttyd, code-server)
│   └── start-full.sh            # full-profile service startup
├── deploy/
│   ├── chart/valet/         # Helm chart (api, postgres, registry, RBAC)
│   └── agent-sandbox/       # Vendored Sandbox CRD controller manifest
├── docs/
│   └── specs/               # Subsystem specs (source of truth per domain)
├── Makefile                 # dev-local, k8s-*, tests, registries
└── .beans/                  # Task tracking
```

## Tech Stack

| Layer | Tech | Key Files |
|-------|------|-----------|
| API server | Hono 4, @hono/node-server + node-ws, better-auth, Drizzle, pi-ai | `packages/api/src/` |
| Engine | @earendil-works/pi-agent-core, TypeBox schemas | `packages/engine/src/` |
| Store | Postgres (PGlite dev / node-postgres prod), raw SQL migrations | `packages/store-postgres/` |
| Web | React 19, Vite 6, TanStack Router/Query, Zustand, Tailwind, Radix UI | `packages/web/src/` |
| Sandboxes | dockerode / agent-sandbox CRs / host processes | `packages/sandbox-*/` |
| Sandbox image | node:22-bookworm-slim, code-server, ttyd, gh | `docker/Dockerfile.sandbox-k8s` |
| CLI / binary | Bun `--compile` single-file executable | `packages/api/src/cli/`, `packages/api/build/` |
| Deploy | Helm, bundled postgres:17 + registry:2, BuildKit prebuilds | `deploy/chart/valet/` |

See [`docs/architecture.md`](architecture.md) for the deep dive and
[`docs/specs/`](specs/) for per-subsystem specifications.
