# API Reference

All endpoints are served by `@valet/api`. Response and request DTOs are
the TypeScript types in `packages/api/src/wire/types.ts`, which the web
client imports as `@valet/api/wire`. That file is the authoritative
contract. This page is the map.

## Authentication

Requests to `/api/*` are resolved in priority order:

1. `x-valet-internal` — server-internal calls.
2. `x-valet-sandbox` — sandbox bearer token (valid only on `/api/memory` and `/api/sandbox`).
3. better-auth session cookie (browser).
4. `x-api-key` — API keys (`vlt_` prefix), for the CLI and automation.
5. Local dev stub (`VALET_LOCAL_AUTH=1`, only without real auth).

Public (unauthenticated) endpoints: `GET /api/health`, `GET /api/auth-config`,
the better-auth handlers under `/api/auth/*`, OAuth discovery under
`/.well-known/*`, `/mcp` (OAuth-Bearer-guarded), channel webhooks, and GitHub
App webhooks (HMAC-verified).

## Sessions

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/sessions` | GET / POST | List / create sessions |
| `/api/sessions/:id` | GET / PATCH / DELETE | Detail, update (title etc.), delete |
| `/api/sessions/:id/pause` | POST | Pause the session |
| `/api/sessions/:id/sandbox-jwt` | POST | Mint a short-lived gateway JWT |
| `/api/sessions/:id/ws` | WebSocket | Live event stream (`?fromOffset=` to resume) |
| `/api/sessions/:id/gateway/*` | ALL | Authenticated proxy to the sandbox gateway (terminal, VS Code) |

### Messages, threads, decisions

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/sessions/:id/messages` | GET / POST | Thread history (`?threadId=`) / send a prompt → `{ messageId, threadId }` |
| `/api/sessions/:id/threads` | GET / POST | List / create threads |
| `/api/sessions/:id/threads/:threadId` | PATCH | Rename, set queue mode |
| `/api/sessions/:id/threads/:threadId/abort` | POST | Abort the running turn |
| `/api/sessions/:id/decisions` | GET | List decision gates |
| `/api/sessions/:id/decisions/:gateId/resolve` | POST | Resolve a gate |
| `/api/sessions/:id/decisions/:gateId/withdraw` | POST | Withdraw a gate |

The WebSocket `init` frame is metadata-only. History always loads over REST.
Wire event types are listed in
[architecture.md](architecture.md#websocket-and-wire-protocol).

## Workspace runtime

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/workspaces/:workspace/runtime` | POST | Ensure the workspace's runtime session (`user` or a team id) |
| `/api/workspaces/:workspace/runtime/info` | GET | Runtime session id, presence, and active child count |

## Workflows

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/workflows` | GET / POST | List / create definitions |
| `/api/workflows/:id` | GET / PUT | Get / update a definition |
| `/api/workflows/:id/runs` | GET / POST | Run history / start a run |
| `/api/workflows/runs/:runId` | GET | Run detail |
| `/api/workflows/runs/:runId/approvals/:nodeId` | POST | Resolve an approval node |
| `/api/workflows/runs/:runId/cancel` | POST | Cancel a run |

## Integrations & credentials

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/plugins` | GET | Installed plugins and their capabilities |
| `/api/credentials` | GET / POST / DELETE | Integration credentials (manual entry) |
| `/api/credentials/...connect` | GET/POST | OAuth connect flow (per-service, driven by plugin credential declarations) |
| `/api/me/github` | — | GitHub App user-OAuth connect. Alias of `/api/plugins/github/http/connection` |
| `/api/plugins/:name/http/*` | varies | Authenticated routes that a plugin declares |
| `/api/me/identity-links` | GET / DELETE | Chat identity links (e.g. Telegram) + link codes |
| `/api/repos` | GET | Repos available for session binding |

## User & org

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/me` | GET / PATCH | Profile, org role, default model |
| `/api/models` | GET | Model catalog |
| `/api/notifications` | GET / POST | Attention notifications + preferences |
| `/api/memory` | GET / PUT / DELETE | Memory file tree (also sandbox-token accessible) |
| `/api/teams` | GET / POST / ... | Teams and team membership |
| `/api/org` | GET / PATCH | Org settings (admin) |
| `/api/org/invites` | GET / POST / DELETE | Invites (admin) |
| `/api/org/llm-providers` | GET / POST / DELETE | BYO LLM provider keys (admin) |
| `/api/org/github-app` | — | GitHub App manifest setup (admin). Alias of `/api/plugins/github/http/app` |
| `/api/org/sources/health` | GET | Org cache bytes, registry capacity, reserve status, and recent push failures (admin) |
| `/api/org/sources` | GET / POST / PATCH / DELETE | Sandbox image sources and their bakes (admin) |
| `/api/admin` | — | Operator submission surface (admin) |

## System

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Version + sandbox backend |
| `/api/auth-config` | GET | Which auth methods the login page should show |
| `/mcp` | ALL | MCP endpoint (streamable HTTP, OAuth Bearer) |
| `/api/channels/:channelType/webhook` | POST | Channel webhook ingress |
| `/webhooks/github-app` | POST | GitHub App events. Alias of `/plugins/github/http/webhook` |
| `/plugins/:name/http/*` | varies | Public routes that a plugin declares |
| `/api/sandbox/git-credential` | — | Git credential helper callback (sandbox token) |

Errors are JSON. Anything else under `/` serves the web client's static build
with an SPA fallback.
