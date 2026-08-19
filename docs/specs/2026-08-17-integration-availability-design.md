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
type ConnectMode = "oauth" | "manual" | "org" | "unconfigured";

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
5. `requires.orgCredential` with the org credential stored → `"org"`. The
   org credential provides the service (sessions resolve it by owner
   escalation — slack-user-integration design, section 5), so there is
   nothing for a user to connect and no token entry is offered. The
   personal path, when a service has one, is its own declaration (e.g.
   `slack-user` OAuth).
6. Otherwise → `"manual"`.

`unavailableServiceSet(plugins, orgId, credentials, env)` returns the
services that resolve to `"unconfigured"`, for the two enforcement points
that gate by set membership (session builds, workflow invocations).

## Enforcement points

**1. `/api/plugins` (presentation).** `PluginServiceSummary.connect` becomes
`"oauth" | "manual" | "org" | "unconfigured"`. Everything else on the
summary stays: an unconfigured-but-connected service still reports
`connected`, health, and disconnect works.

**2. `PUT /api/credentials/:service` (manual save).** A user-scope save for
a service that resolves `"unconfigured"` or `"org"` is rejected with an
error that names the corrective action. Org-scope saves are exempt — an
admin's org-scope Slack save is exactly how the service becomes configured.
Unknown services (no declaration) stay accepted, as before.

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
  grid, unless the caller can fix it (below).
- Unconfigured and **connected** → the tile renders with Disconnect and a
  note naming the fix for the cause that blocks it (generalizing the GitHub
  org-note slot). See "Two causes, three notes" below.
- `"org"` → the tile renders with no token entry. When the provider
  declares an `identityLink` and `GET /api/me/identity-links` reports its
  transport ready, the tile carries the member's own step instead: the
  pairing block (`identity-link-block.tsx`). A linked account reads
  "Linked as <externalId>" with Unlink. Providers with no identity link get
  the note "Provided by your organization. An admin manages it in Settings →
  Organization." A leftover user credential keeps its Disconnect.
- The pairing block's entry points are gated by the `IdentityLinkStatus`
  flags:
  - **DM me the code** (`codeDelivery`) — `POST
    /api/me/identity-links/:provider/deliver` resolves the caller in the
    workspace by their Valet email (Slack: `users.lookupByEmail`, needs the
    `users:read.email` bot scope), mints the code, and DMs the plugin's
    `deliveryDm` text. The card echoes the DM byte-identical so the user
    knows what to look for. A 202 (`email_not_in_workspace`) falls back to
    member search when available, else to the show-code flow.
  - **Find me by name** (`memberSearch`) — `GET .../members?query=` is a
    workspace typeahead; picking a member POSTs `deliver` with that
    `externalId`. Safe because the DM alone links nothing: the link happens
    only when the recipient replies `link <code>` from their own account,
    and the DM text tells an unexpecting recipient to ignore it.
  - The show-code flow (`POST .../start`: code + the provider's delivery
    instructions + expiry) is never a third button. It is the single
    "Link account" flow for providers without `codeDelivery` (Telegram),
    and the automatic fallback above.
  While a code is out, the block polls `GET /api/me/identity-links` (3s) so
  the tile flips to "Linked" when the user completes the flow in the
  provider app.

## Telling the org admin which setting is missing

Hiding a tile is right for a person who cannot act. It is wrong for the
operator who can: gmail, google-calendar and google-workspace all declare
`clientIdEnv: 'GOOGLE_CLIENT_ID'`, so a deployment that never set that pair
loses three tiles with no trace, and nothing on the page names the two
variables that stand between the operator and a working integration.

`PluginServiceSummary` gains two optional fields:

```ts
/** Present whenever `connect === "unconfigured"`, for every caller. Which
 * prerequisite blocks the connection — rule 3 or rule 4. */
connectBlockedBy?: "deployment" | "org";
/** Present only when `connectBlockedBy === "deployment"` AND the caller is
 * an org admin. Names only, from the declaration's own
 * clientIdEnv/clientSecretEnv. */
missingEnv?: string[];
```

`missingClientEnv(plugins, service, env)` (same module as `connectModeFor`)
builds `missingEnv` by filtering the declaration's two name fields on
presence. It reads the resolution and does not change it — rule 3 is
unchanged. It also decides `connectBlockedBy`: rule 3 is the only
unconfigured arm with an environment variable behind it, so a non-empty
result means "deployment" and an empty one means "org".

**Names are not values.** `env` is read only as a presence test, the same
test `authCodeEnvReady` makes, and the field's type is `string[]` of manifest
names. `resolveClientEnv` — the one function in this area that returns
secret material — is not on this path.

**The gate is server-side.** `/api/plugins` resolves `isOrgAdmin` once per
request against `org_members.role` and omits `missingEnv` for everybody
else, so the field's presence IS the permission and the client needs no
second gate. One other route can name these variables:
`GET /api/credentials/:service/connect` returns them in the `missing` array
of its 503 body, and it now holds the same `isOrgAdmin` gate on that array
(`routes/credential-connect.ts`). Both surfaces read `missingClientEnv`, so
they cannot name a different set, and a member reads the names on neither.

The gate decides who is SHOWN the reason. A variable name is not a secret,
and the two 503 bodies differ only in whether they name one — every caller
is told the service is unconfigured, and every caller is told what to do
next.

**Two causes, three notes.** Rule 3 and rule 4 have different fixes, and
only one of them is a page in the product. `connectBlockedBy` carries the
cause to every reader, because a member who still sees the tile (a leftover
credential keeps it on screen) must not be sent to a page that cannot help:

| Cause | Caller | Note |
|-------|--------|------|
| deployment | org admin | "This deployment has no OAuth client for this service. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in the server environment. Then restart the server." |
| deployment | member | "This deployment has no OAuth client for this service. Ask an org admin to set it up." |
| org | anybody | "Not configured for this organization. An admin can set this up in Settings → Organization." |

**The tile stays informational.** `isVisibleService` shows an unconnected
tile only when `missingEnv` is non-empty, so visibility keys on the
admin-only field and never on `connectBlockedBy`.

No control appears. Setting a server variable and restarting is a deployment
step the browser cannot take, and `GET /api/credentials/:service/connect`
still 503s while the env is unset — a Connect button here would fail exactly
the way the dead button that this design removed did.

Both pairs of Google variables are documented together in `.env.example` and
`docs/environment-variables.md`: `AUTH_GOOGLE_*` is sign-in, `GOOGLE_*` is
these three integrations, and the server reads them separately.

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
