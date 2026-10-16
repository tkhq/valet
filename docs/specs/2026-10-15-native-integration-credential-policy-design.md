# Native integration credential policy

Date: 2026-10-15. Status: implemented.

Depends on: `2026-07-20-event-system-design.md` (the Linear app connection),
`2026-08-24-team-credentials-and-workflow-bootstrap-design.md` (team rows,
shares, borrowing, `credential: "app"`).

## Problem

Valet owns an app identity for GitHub, Slack, and Linear. GitHub and Slack
actions already fall back to that identity. Linear actions do not: they use
Linear's hosted MCP server with each person's own OAuth token, so nothing
works until a person connects Linear, and every action appears as that
person. The org already holds a Linear app connection with an `actor=app`
token, but only webhooks use it.

The event-system spec says "App credentials stay excluded from agent and
workflow credential resolution". The code holds that rule for user and team
owners only. An org-owned session or workflow run reads the full org
`linear` row, and its metadata includes the webhook signing secret
(`packages/api/src/services/credential-resolution.ts`
`resolveOrgCredentialRead`).

## Thesis

Integrations come in two classes. A **native integration** has an app
identity that Valet owns; an action falls back to that identity when no
person's credential applies. An **MCP server or plugin** uses only the
credential that was configured for it. The resolver hands an app identity
to an action as a bare token, never as the stored row.

## Requirement language

MUST, MUST NOT, SHOULD, and MAY follow RFC 2119. A sentence without one of
these words is informative.

## Terminology

- **native integration**: a plugin whose manifest sets `native: true`.
  Today: GitHub, Slack, Linear.
- **personal credential**: a credential row owned by a user.
- **delegated credential**: a personal credential that its owner shared with
  a team (`credential_shares`), or the team's own connection (a team-owned
  row). Both act as a person, not as the app.
- **app credential**: the integration's app identity for the org: a GitHub
  App installation token, the Slack bot token, or the Linear `actor=app`
  token.
- **app token**: an app credential reduced to `{ accessToken }`. It carries
  no metadata.

## Acceptance scenario (normative)

Universe: org `acme` with the Linear app connected (org `linear` row,
`grant: client_credentials`). User `u-001` has no Linear connection. User
`u-002` has a Linear connection and shared it with team `platform`.

| Step | Action | Expected observation |
|---|---|---|
| P1 | In a personal session of `u-001`, the agent creates a Linear comment. | The request to `mcp.linear.app` carries the app token. Linear shows the comment by the Valet app. |
| P2 | In a personal session of `u-002`, the agent creates a comment. | The request carries `u-002`'s token. |
| P3 | In a `platform` team session, the agent creates a comment. | The request carries `u-002`'s shared token (borrow rules apply as today). |
| P4 | `u-002` revokes the share. The team agent creates a comment. | The request carries the app token. |
| P5 | In an org-owned session, a plugin reads its `linear` credential. | It receives `{ accessToken }` only. No `webhookSecret`, `workspaceId`, or other metadata reaches the plugin. |
| P6 | A config-declared MCP server with no credential is called in a team session. | The call is refused as today. No app credential is tried. |

Pass criterion: all steps, in one run, from a clean start. Step P1 depends on
spike S1 below.

## Part A: Classification

1. `ValetPlugin` gains `native?: boolean`. `validateValetPlugin` accepts it.
2. GitHub, Slack, and Linear set `native: true`. No other plugin sets it.
   Config-declared MCP servers MUST NOT be native.
3. Each native plugin names its app credential service:
   `appCredentialService?: string` (`github:installation`, `slack`,
   `linear:app`).

## Part B: Resolution order

For a native integration, the host credential resolver MUST try, in order:

| Session owner | Order |
|---|---|
| user | personal credential → app token |
| team | the acting member's share → the team's own connection → other members' approved shares → app token |
| org | app token |

- A non-native service keeps today's order and MUST NOT reach an app token.
- An explicit choice still wins over the default: a repository binding
  `session_repos.auth`, or a workflow node `credential: "app" | "user"`.

## Part C: Per integration

- **GitHub.** Today's behavior already matches Part B for user and team
  sessions. Change: an org-owned workflow run on `auto` MUST use the
  installation, as org sessions do, before the org personal-access-token
  row (`action-invoker.ts` passes no `auth` today).
- **Slack.** No change. `slack.*` actions act as the bot by design, so its
  messages never appear as a person. The person's identity is the separate
  `slack-user` service (`slack-user.*` tools), which is personal or
  delegated only. This spec records that mapping and changes nothing.
- **Linear.**
  1. The host resolves `linear:app` from the org `linear` row with
     `grant: client_credentials`, as an app token. `LinearAppTokenStore`
     keeps renewing that row.
  2. `mcpActionPlugin` gains `appCredentialService?: string`. When
     `credentials.get()` returns null, it calls
     `credentials.get(appCredentialService)` before it refuses. It applies
     this to tool discovery and to calls. It also sets
     `appCredentialService` on the `ActionPlugin` it returns. The
     `list_tools` probe in `plugin-catalog.ts` tries that service when the
     personal credential is absent. If either one answers, the probe counts
     the service as connected and does not hide its tools.
  3. The Linear plugin passes `appCredentialService: "linear:app"`.

## Part D: The org row leak

1. `resolveOrgCredentialRead` MUST apply the class rule: for a native
   integration's app credential row, return an app token only.
2. For any service whose org row holds an app credential and that is not
   native, the org read MUST return null.
3. The deny list keeps `github_app`, `linear_app`, and 1Password.

This part ships first, in its own commit, because it closes a live exposure.

## Part E: Workflows

1. The `credential` field on a tool node MAY name `app` or `user` for any
   native service. The refusal at `action-invoker.ts:393` keeps applying to
   non-native services.
2. Team readiness (`team-service-readiness.ts:381`) checks an `app` node of
   a native service through that service's app credential.

## Spike S1 (before Part C Linear)

Confirm that `mcp.linear.app` accepts an `actor=app` client-credentials
token as a bearer credential and attributes a comment to the app. If it
does not, Linear actions with the app token MUST go through native GraphQL
actions for the tools agents use most (comments, issue state, labels,
assignees), and this spec records that deviation before code.

Resolution (2026-10-16): Linear's MCP documentation states that the server
accepts a bearer OAuth token and that an `actor=app` token acts as the app
user. The native GraphQL fallback was not built. The live check (a comment
made with the app token shows the Valet app as its author) runs on the dev
deployment after merge.

## Invariants

- **INV-P1 An app credential reaches an action as a bare token.**
  Mechanism: the resolver builds `{ accessToken }` for every app credential
  service; a test asserts no metadata key survives. Vector: P5.
- **INV-P2 A non-native service never receives an app token.** Mechanism:
  Part B consults `native` before the app step; a test for a config MCP
  server. Vector: P6.
- **INV-P3 A person's credential wins over the app when it applies.**
  Mechanism: the Part B order. Vectors: P2, P3.

## Consequences

- A member without access to a private Linear team, Slack channel, or
  GitHub repository can reach it through the app identity when the app can.
  GitHub already behaves this way. This follows the policy the product
  owner set on 2026-10-15.
- Event waiters read subjects with the session's resolved credential. Once
  this ships, team sessions can wait on private Slack channels the bot is
  in, and the event wakeups spec's "public channels only" rule for team
  sessions SHOULD be lifted in a follow-up.

## Testing

- Resolver unit tests for every row of the Part B table, per owner type.
- INV-P1 and INV-P2 vectors.
- `mcpActionPlugin` tests for the app fallback in discovery and in calls.
- The acceptance scenario as an integration test with a stub MCP server.
- Spike S1 as a recorded manual check in the PR.

## Non-goals (normative boundary)

| Excluded | Why | Re-entry seam |
|---|---|---|
| Slack messages posted as a person through `slack.*` | Bot posts stay the bot by design | The `slack-user` service |
| Per-user visibility checks on app-identity reads | Product decision on 2026-10-15 | A visibility layer in the resolver |
| Native status for other plugins | No app identity exists for them | Part A `native` flag |

## Deviations

1. **INV-P2 holds per service, not per caller.** The resolver gives an app
   token to any read of a service that a native plugin names
   (`appCredentialService`). It does not check which plugin makes the read.
   First-party plugins share one trust boundary, so this is acceptable. A
   config-declared MCP server cannot reach an app token, because it is
   never native and cannot name a native service's app credential.
2. **Org-owned GitHub workflow runs on `auto` use the installation, then
   the org PAT row.** A strict app-only order breaks orgs that use only a
   PAT. The PAT answers only when no installation resolves (`null`). If
   the installation mint fails with an error, the run fails with that
   error and does not use the PAT. `action-invoker.test.ts` holds this.
3. **Spike S1 was resolved from Linear's documentation**, not from a live
   call. The live check runs on the dev deployment after merge.
4. **The app credential row map is a fixed list.**
   `APP_CREDENTIAL_ROWS` in `services/credential-resolution.ts` maps
   `linear:app` to the org `linear` row. A new native service with a
   row-backed app credential needs a new entry.
5. **Fallbacks to the app token are counted.** The counter
   `valet_credentials_app_fallback_total{service,reason}` (OTel name
   `valet.credentials.app_fallback`) increments when a read ends at a
   row-backed app token: in session reads (`engine/host.ts`) and in
   workflow tool-node reads (`plugins/action-invoker.ts`). Reasons:
   `no_personal` (a user owner had no row), `no_delegated` (a team had no
   share and no team row), `dead_delegated` (a team share or team row
   existed but could not answer), and `org_owner` (an org-owned read).
   A broken delegated credential keeps working through the app, so alert
   on `dead_delegated` instead of letting the app token hide it. GitHub
   installation fallbacks and the Slack bot row are not counted: the
   Slack bot row is that service's only identity, and GitHub has its own
   token-source path.
6. **MCP 401 and 403 responses name the credential and the fix.** The MCP
   client throws a typed `McpHttpError` with the HTTP status.
   `mcpActionPlugin` checks the status, not the response text, during
   discovery and calls. With the app token, the message asks an admin to
   reconnect the app, or the person to connect their own account. With a
   personal token, it asks the person to reconnect.
7. **Workflow tool nodes follow Part B on `auto`, and Part E for pins.**
   `auto` reads a person's credential first and the app token last. A
   team run is not refused when the app token answers, and it keeps
   today's borrow approval for another member's share. `app` reads the
   app identity: the Linear app token, or the org Slack bot row. A run
   pinned to `app` with no app connection is refused with the admin fix.
   `user` never reaches the app token, and an org-owned run pinned to
   `user` is refused, because it has no person to act as. Team readiness
   gives the same answers (team credentials design, deviation 26).
