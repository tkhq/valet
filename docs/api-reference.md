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
| `/api/sessions/:id` | GET / PATCH / DELETE | Detail, update (title etc.), delete. An owner move (`teamId`) stops all background work; a `profile` change stops process, watch, and hold work, also when the api restarted and the sandbox is not live. Both follow the background-work rule below. A move can 403 for a caller who may not stop the work |
| `/api/sessions/:id/pause` | POST | Pause the session. Follows the background-work rule for process, watch, and hold work; timers keep their schedule. When the sandbox is not attached, 409 `The sandbox is not attached yet. Send a message in the session, then pause again.` before the background-work check |
| `/api/sessions/:id/sandbox/replace` | POST | Replace the sandbox. Same rule as pause |
| `/api/sessions/:id/wakeups` | GET | Open wakeups and active leases → `{ wakeups, leases }` (no command or exec id) |
| `/api/sessions/:id/wakeups/:wakeupId/cancel` | POST | Cancel one wakeup (`wk_`) or hold (`ls_`) as a person. The agent gets the terminal signal with `cause=cancelled`. Session admins only |
| `/api/sessions/:id/sandbox-jwt` | POST | Mint a short-lived gateway JWT |
| `/api/sessions/:id/ws` | WebSocket | Live event stream (`?fromOffset=` to resume) |
| `/api/sessions/:id/gateway/*` | ALL | Authenticated proxy to the sandbox gateway (terminal, VS Code) |

### Background-work rule

Pause, replace, a profile change, an owner move, and a thread archive stop
background work. While such work is open, these actions return 409 with a
`BackgroundWorkConflict` body:
`{ error, code: "background_work", work, hiddenCount, forceAllowed }`.

- `work` lists only work on threads the caller can see: id, kind, status
  (`pending` while it starts, else `running`), reason, thread, deadline or
  fire time, and start time. `hiddenCount` counts the rest. Their reasons
  are not shown.
- Work with no thread belongs to the session. The 409 names it to every
  caller and never counts it as hidden. Only callers who may cancel
  background work see it in `GET /api/sessions/:id/wakeups` or can cancel
  it.
- Pause, replace, and a profile change read the leased work again right
  before they stop the sandbox. Work that started after the gate returns
  409 with `background work started` in the text; retry to see it.
- A thread archive, forced or not, returns 409 while a turn runs in that
  thread. A turn that waits on an approval does not count: the archive
  withdraws the approval.
- To stop the work and act, retry with `force: true` in the JSON body. Pause
  and replace also accept `?force=true`.
- `force` needs the right to cancel background work (session admins). A
  caller without it gets 403.
- `force` is refused (409, `forceAllowed: false`) while work runs on threads
  the caller cannot see. Ask the people in those threads to stop it.
- A caller who may not cancel the work also gets `forceAllowed: false`. Ask
  the agent to cancel it with `wakeup_cancel`, or ask a team admin.
- A forced action cancels each item as a person. The agent gets the
  terminal signal with `cause=cancelled`. Pause and replace send it after the
  sandbox stops. A move sends it after the owner change. An archive sends it
  to the session's main thread, without the log tail and the channel
  origin, and adds a system note to the archived thread.
- The response lists the stopped ids: `cancelledWork` (pause, replace,
  archive), and `cancelledWork` with `cancelledWorkCount` (PATCH).
- If a turn starts while the work stops, the action returns 409. The work is
  already stopped. Wait for the turn to finish, then retry.
- If new background work starts before pause or replace stops the sandbox,
  the action returns 409 and does not stop the sandbox. Retry to see the
  new work.
- An archive without `force` returns 409 while a turn runs in the thread:
  `A turn is running in this thread. Wait for it to finish, then archive.`

### Messages, threads, decisions

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/sessions/:id/messages` | GET / POST | Thread history (`?threadId=`) / send a prompt → `{ messageId, threadId }` |
| `/api/sessions/:id/threads` | GET / POST | List / create threads |
| `/api/sessions/:id/threads/:threadId` | PATCH | Rename, set queue mode, archive. An archive of a thread with background work follows the background-work rule |
| `/api/threads/:threadId` | PATCH | The same operation by thread id; the web app uses it. Archive follows the background-work rule with the same 409 and `force` contract |
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
| `/api/me/github` | — | GitHub App user-OAuth connect |
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
| `/api/org/github-app` | — | GitHub App manifest setup (admin) |
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
| `/webhooks/github-app` | POST | GitHub App events |
| `/api/sandbox/git-credential` | — | Git credential helper callback (sandbox token) |

Errors are JSON. Anything else under `/` serves the web client's static build
with an SPA fallback.
