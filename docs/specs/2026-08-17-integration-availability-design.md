# Integration availability design

Date: 2026-08-17
Status: implemented

## Problem

The `/integrations` page offers a Connect button for every service a plugin
declares. It does not ask whether the deployment or the organization can
support the connection:

- Slack renders "Connect Slack (bot token)" even when no admin has connected
  the org Slack app (Settings → Organization → Slack). The pasted token gives
  outbound-only actions, and the channel half of the integration is dead.
- Google Workspace and Google Calendar fall back to manual token entry when
  `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are unset. A pasted Google access
  token expires in about one hour, and a refresh needs the missing client
  secret — the manual path can never produce a working credential.
- The agent's `list_tools` catalog has the same gap: tools for these services
  stay visible (see the inference bug below) even when nobody in the
  deployment can connect them.

The one integration that gets this right is GitHub: its org App status has
its own routes, and the UI explains a missing App instead of offering a
connect path that fails.

## Decision

A credential declaration can name a deployment/org prerequisite. One
resolver in the API classifies every declared service as connectable or
unconfigured. The classification:

1. drives the connect UI (tri-state `connect` on the wire),
2. blocks manual credential saves for unconfigured services,
3. removes unconfigured services' tools from every session build, and
4. blocks workflow action invocations for unconfigured services.

"Configured" is not one kind of fact, so the resolver reads two sources:

| Service class | Prerequisite | Source | Example |
|---|---|---|---|
| OAuth (authorization_code) | client env vars set | `process.env` via the declaration's `clientIdEnv`/`clientSecretEnv` | google-workspace, google-calendar |
| OAuth (mcp mode) | none — the remote server owns the dance | — | figma-style MCP services |
| Org-app-backed | org-scoped credential for the service exists | credential store at `{type:"org", id:orgId}` | slack |
| Self-sufficient key | none — a personal token works alone | — | linear, notion |

Availability for org-app-backed services is a per-org, DB-backed fact. It
can change at runtime, so enforcement runs per request/per session build,
not at process start.

## The `requires` declaration

`CredentialDeclaration` (engine, `valet-plugin.ts`) gains one optional
field:

```ts
/** Deployment/org prerequisite for offering this credential. Absent = the
 * credential is self-sufficient (a personal token works with no org setup)
 * and the service is always offered. `orgCredential: true` = an org-scoped
 * credential for this service must exist before users can connect;
 * an admin creates it in Settings → Organization. */
requires?: { orgCredential: true };
```

OAuth `authorization_code` declarations need no `requires`: their env
requirement is already declared (`clientIdEnv`/`clientSecretEnv`) and is
now enforced instead of falling back to manual entry.

The engine stays policy-free: it carries the field, the API evaluates it.

Slack declares `requires: { orgCredential: true }`.

## Resolution rules

`packages/api/src/services/integration-availability.ts` exports the single
definition:

```ts
type ConnectMode = "oauth" | "manual" | "unconfigured";

connectModeFor({ plugins, decl, service, orgId, credentials, env }): Promise<ConnectMode>
```

Rules, in order:

1. An oauth declaration in `mode: "mcp"` → `"oauth"`.
2. An `authorization_code` declaration with both client env vars set →
   `"oauth"`.
3. An `authorization_code` declaration with either env var unset →
   `"unconfigured"`. (This replaces the manual fallback the
   2026-07-20 integration-OAuth design specified — see Deviations.)
4. `requires.orgCredential` with no org-scoped credential stored for the
   service → `"unconfigured"`.
5. Otherwise → `"manual"`.

`unavailableServiceSet(plugins, orgId, credentials, env)` returns the
services that resolve to `"unconfigured"`, for the two enforcement points
that gate by set membership (session builds, workflow invocations).

## Enforcement points

**1. `/api/plugins` (presentation).** `PluginServiceSummary.connect` becomes
`"oauth" | "manual" | "unconfigured"`. Everything else on the summary stays:
an unconfigured-but-connected service still reports `connected`, health, and
disconnect works.

**2. `PUT /api/credentials/:service` (manual save).** A user-scope save for
a service that resolves `"unconfigured"` is rejected with an error that
names the corrective action. Org-scope saves are exempt — an admin's
org-scope Slack save is exactly how the service becomes configured. Unknown
services (no declaration) stay accepted, as before.

**3. Session builds (agent tools).** `EngineHost.sessionExtras` — the one
funnel for all four session builders — filters the plugin set through
`gateUnavailableActions(plugins, unavailable)` before `pluginSessionExtras`.
The gate strips `ActionPlugin`s whose credential key
(`credentialService ?? service`) belongs to an unconfigured declaration.
Credentials, skills, roles, triggers, and transports stay — only agent-facing
tools are gated. `list_tools` never sees the service; there is nothing to
hide downstream.

**4. Workflow invocations.** `invokeAction` (headless `ActionInvoker`)
checks the service against `unavailableServiceSet` for the run's `orgId`
and returns a deterministic error naming the corrective action.

`GET /api/credentials/:service/connect` already 503s on missing OAuth env;
it keeps that behavior and is now consistent with the listing by
construction.

Existing stored credentials are untouched. When an admin removes the org
app after users connected, those users keep their rows (the tile shows
disconnect), but sessions stop receiving the tools.

## Web behavior

- `connectPath` and the tile renderer handle `"unconfigured"` (the
  tri-state makes the new case a type error to ignore).
- Unconfigured and **not connected** → the tile does not render in the
  grid.
- Unconfigured and **connected** → the tile renders with Disconnect and a
  note: "Not configured for this organization. An admin can set this up in
  Settings → Organization." (generalizing the GitHub org-note slot).

## Adjacent fix: `requiresCredential` inference

`withCredentialRequirement` (`plugins/assemble.ts`) infers
`requiresCredential` from `decl.service` without the `?? plugin.name`
fallback every other consumer applies. Every plugin that omits
`decl.service` (slack, google-*, linear, …) therefore never got the flag,
and `list_tools` listed their tools while unconnected. Fixed in the same
change, with tests.

## Out of scope (deliberate)

- **GitHub** keeps its bespoke org-App gating and UI line. Unifying it
  under `connectModeFor` is a later cleanup.
- **Triggers and transports** are not gated. Webhook ingress already fails
  closed without the org secret.
- **Instance config as a source.** The resolver is one function; adding
  `VALET_CONFIG` keys as a third source later touches only its body.
- **Any-of env expressions** (e.g. Slack Socket Mode token as an
  alternative to the signing secret). Add when a deployment needs it.

## Deviations from prior specs

`2026-07-20-integration-oauth-design.md` specified that an
`authorization_code` service with unset client env reports `"manual"` so
the UI renders token entry instead of a 503ing Connect button. This design
replaces that fallback with `"unconfigured"`: the manual path cannot
produce a refreshable Google credential, so offering it was misleading.
The prior spec carries a pointer to this document.
