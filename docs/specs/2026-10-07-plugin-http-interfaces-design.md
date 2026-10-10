# Plugin HTTP interfaces

Status: first iteration implemented for TKAI-377. Slack, GitHub, and Linear routes use the registry. Security adoption remains.

## Intent and scope

Plugins must own provider-specific HTTP behavior. The host must enforce authentication, tenant boundaries, request limits and mounting rules.

The starting ticket is [TKAI-377](https://linear.app/turnkey/issue/TKAI-377). Its companions are [storage](https://linear.app/turnkey/issue/TKAI-378), [lifecycle hooks](https://linear.app/turnkey/issue/TKAI-379) and [event production](https://linear.app/turnkey/issue/TKAI-380).

Existing webhook URLs, OAuth callbacks, saved credentials, installation records and subscription behavior must remain compatible. No installation or user data is deleted.

## Current evidence

- `packages/engine/src/valet-plugin.ts` has no HTTP route declaration.
- `packages/api/src/app.ts` explicitly mounted Slack, GitHub, Linear and Security route families. Slack, GitHub, and the Linear connection now mount through the registry.
- `packages/api/src/routes/event-webhooks.ts` resolves Linear installations and signing secrets in a service-name branch.
- `packages/api/src/services/plugin-store.ts` already supports scoped documents and indexes.
- Linear setup now uses client credentials. The ticket's older OAuth flow description must not replace the current connection behavior.

## Alternatives

1. Export Hono routers from plugins. This is small, but couples plugins to the API framework and exposes middleware ordering to plugins.
2. Declare portable request handlers and supply narrow host capabilities. This requires adapters but preserves engine portability and central authorization.
3. Move every plugin table, lifecycle and event operation at once. This removes more core branches but combines migration risk with HTTP compatibility changes.

Use option 2. Move one existing provider at a time through the same interfaces. Treat storage relocation and new event semantics as companion work.

## Contract

Add portable HTTP descriptors to `ValetPlugin`. A descriptor has a stable ID, method, relative path, authentication category and bounded body size.

The handler receives a normalized request: URL, headers, path parameters, raw body bytes and cancellation signal. It returns a standard response.

Authenticated handlers receive a host-derived caller and organization. Organization administration is a separate declared requirement. Team API keys retain existing restrictions.

Plugins do not receive `AppDb`, a Hono context or the complete providers object. Host capabilities expose only the operations needed by a handler.

Canonical routes are namespaced under the plugin name. The host owns a fixed compatibility map for existing bundled-plugin URLs. A plugin cannot claim another plugin's namespace or shadow a core route.

Validate descriptors at assembly. Reject invalid paths, duplicate method/path pairs, unsupported methods, invalid limits and incompatible authentication declarations before serving requests.

## Public ingress

Separate public protocol endpoints from signature-verified event ingress. Public callbacks must declare the existing state-validation protocol; they cannot obtain authenticated capabilities from caller-supplied organization IDs.

For signed ingress, a resolver may identify an installation using bounded raw input. This candidate is untrusted until signature verification succeeds.

Installation lookup and signing-secret access use narrow host capabilities. Unsigned requests must not refresh credentials or cause provider network calls.

The host enforces the request limit while reading the stream. A missing or false Content-Length header must not bypass the limit.

Only verified ingress receives the organization-scoped emission capability. The host owns subscription matching, dispatch, receipts and retry semantics.

Preserve provider acknowledgements and raw-byte signature verification. Do not decode and re-encode the request before verification.

## Adoption order

1. Introduce descriptor validation and generic mounting, with test plugins proving the host contract.
2. Move Linear's ingress parser and resolution orchestration into its plugin. Keep the existing installation table behind a narrow adapter initially.
3. Move Linear connection handlers and provider HTTP logic. Preserve the current client-credentials flow and existing endpoints.
4. Move GitHub's setup, callback, installation and webhook handlers with explicit capabilities for credentials and installation storage.
5. Move Slack setup and signed ingress. Preserve durable inbox admission and its current downstream consumers.
6. Move Security handlers behind scoped domain capabilities. Keep its relational data model intact pending TKAI-378's storage decision.
7. Remove the corresponding manual imports and mounts from `app.ts` once each family uses the registry.

A descriptor-only change does not complete TKAI-377. Completion requires adoption by the route families named in the ticket.

## Companion boundaries

TKAI-378 decides installation document migration and Security's relational requirements. It must include data-preserving backfill and repeatable restart tests.

TKAI-379 owns general credential enrichment, installation discovery, lifecycle and visibility hooks. HTTP capabilities should not become an unrestricted lifecycle container.

TKAI-380 owns typed event schemas, parsers and generic fan-out. Route migration must preserve existing events until that contract replaces them.

Memory and workflows remain core product domains, as specified in TKAI-378.

## Verification

- A test plugin registers an authenticated route without changing `app.ts`.
- Authentication, organization membership and administration failures prevent handler execution.
- Namespace collisions and malformed descriptors fail at assembly.
- Chunked and misleading-length bodies are rejected at the streaming limit.
- Invalid signatures and unknown installations never emit events or refresh credentials.
- Valid legacy webhook URLs retain acknowledgement, retry and deduplication behavior.
- Existing connection, callback, installation and Security route suites pass after each adoption.
- Session and workflow behavior remains unchanged when no route capability is declared.
- Full `make e2e` passes before proposing merge. Record environment-dependent skips separately.

## Delivery

Use a follow-up PR from the merged `dev-v2` base. Keep HTTP adoption commits separate from later storage migrations. Do not change Linear ticket status or post comments without a request.

## First iteration

`ValetPlugin.httpRoutes` supports public, user, organization-admin, and signed event routes.
Public routes use `/plugins/<name>/http/<path>`. Authenticated routes use `/api/plugins/<name>/http/<path>`.
The host rejects overlapping paths, invalid declarations, and bodies above each declared limit. The maximum limit is 1 MiB.
Authenticated callers must have current organization membership. Team keys cannot use these routes.

Linear declares `/events` with signature authentication. The host retains `/webhooks/events/linear` as an alias.
Both URLs use the same event deduplication and dispatch pipeline. The plugin owns payload parsing and trigger selection.
The host supplies every assembled trigger whose service matches the route plugin.
Linear verifies against that complete list, including definitions contributed by other plugins.
Triggers from other services cannot participate in Linear verification.
A temporary host adapter reads existing Linear installations and signing metadata without refreshing credentials.
The installation's stored organization determines event ownership after verification. Request bodies cannot override it.

This iteration does not move Security routes. The Slack, GitHub, and Linear connection sections below describe the later moves.
It does not implement arbitrary callback state capabilities, plugin-owned storage, lifecycle hooks, or the complete event-emission interface.
New signed plugins currently need an installation adapter. This restriction remains until plugin-owned installation storage is available.
No database migration or existing-data rewrite is required.

## Host compatibility checks

The node_modules loader quarantines signed-route plugins when no host installation resolver exists. Other plugins continue to load.
Route mounting retains its defensive check for invalid host configuration.

The host removes Cookie, Authorization, X-API-Key, X-Valet-Sandbox, X-Valet-Internal, and X-Valet-Test-User-ID headers before invoking plugin code.
Authenticated routes receive caller identity through the caller argument. Provider signatures must use separate headers, such as Linear-Signature.
Signature headers and raw body bytes remain unchanged.

## Host bindings

Bundled routes that need host data use one mechanism: the binding table in `packages/api/src/plugins/http-bindings.ts`, keyed by plugin name and route ID.
A binding pins the method, path, and authentication of the declaration it serves. The mount refuses a mismatch, and the node_modules loader quarantines the package.
The mount runs a binding where it would call the manifest handler: after authentication, membership, administration, and the streaming body limit.
The binding calls a handler that the bundled plugin package exports and gives it request-scoped capabilities. No capability method accepts an organization or user ID.
The manifest handlers answer 501, so a host without the binding fails closed. A handler that a plugin declares never receives a capability.

Compatibility URLs live in `LEGACY_ROUTES` in `packages/api/src/plugins/http-routes.ts`, keyed the same way.
Each entry pins its method and authentication, so a plugin cannot widen access to an existing URL. It serves the same handler as the canonical URL.
The mount refuses to boot when a loaded plugin with HTTP routes does not declare a route ID that a binding or compatibility URL names. Without this check, a renamed route would leave its existing URL answering 404. The node_modules loader quarantines such a package instead.

## Linear client preparation

The Linear plugin owns the provider HTTP client for token creation, workspace lookup, and legacy webhook deletion.
The API compatibility module keeps host environment defaults and shares the plugin's token error constructor.
Token renewal ownership remains in the API host.
[The Linear adoption plan](../plans/2026-10-08-linear-plugin-adoption.md) describes the connection route move.

## Slack adoption

The Slack plugin declares two routes. `events` is a public POST route with a 1 MiB limit. `app` is an org-admin GET route.
The host keeps POST `/api/channels/slack/webhook` and GET `/api/org/slack` as compatibility URLs.
Each compatibility URL fixes its method and authentication. Public plugin routes mount before the generic channel webhook route, so the Slack URL still wins.

The plugin owns the URL verification handshake, v0 signature verification over raw bytes, payload parsing, retry headers, response codes, and the app manifest.
The host passes the manifest URLs and the Slack user scope bundle as endpoint configuration.

Both routes use the host bindings described above. Each binding gives the handler one request-scoped capability.

The ingress capability reads the single-org Slack connection, writes throttled diagnostics, and admits a verified request.
Admission saves the encrypted request in `slack_webhook_inbox` before the 200 response. The host stores its own copy of the bytes and provider headers.
The drain and its channel, subscription, and follow-router consumers are unchanged. Inbox and ingest deduplication are unchanged.

Slack signed ingress does not use the generic `signature` route kind. That kind dispatches events before acknowledging.
Slack needs a handshake before credentials exist, a 401 rejection, a 503 retry response, and durable admission before the acknowledgement.

Stored inbox headers no longer include Cookie, Authorization, or Valet credential headers. Slack sends none of them, and the drain reads only Slack signature headers.
If the Slack plugin is not loaded, the compatibility URLs are not mounted. The ingress URL then reaches the generic channel route, which returns 404.

Org credential connect, user OAuth, and identity linking remain generic host routes. They serve several plugins and need TKAI-379 lifecycle hooks before they move.
The inbox table remains an API table pending TKAI-378. New manifests still name the compatibility URL.
The implementation record is [the Slack adoption plan](../plans/2026-10-09-slack-plugin-adoption.md).

## GitHub adoption

The GitHub plugin declares eleven routes in `packages/plugin-github/src/http/`. It owns request parsing, manifest construction, the manifest code conversion, the OAuth code exchange, the profile lookup, HMAC verification, payload parsing, and every response.
The API removed `routes/github-app.ts`, `routes/github-connect.ts`, and their mounts in `app.ts`.
The plan is [the GitHub adoption plan](../plans/2026-10-09-github-plugin-adoption.md). It lists each route, its legacy URL, and its body cap.

Canonical routes are `/api/plugins/github/http/app`, `/app/*`, `/connection`, `/connection/*`, and the public `/plugins/github/http/webhook`.
The host keeps `/api/org/github-app/*`, `/api/me/github/*`, and `/webhooks/github-app` as fixed aliases. Existing GitHub Apps store these URLs, so the manifest still names them.

### Host binding

GitHub uses the host bindings described above.
`packages/api/src/plugins/http-github.ts` binds four capabilities. No capability method accepts a user or organization ID.

- App administration binds to the caller's organization.
- App setup opens a grant only for a setup state the host signed. The state names the org admin who started setup, and the grant opens only for that caller while they are still an admin of the organization in the state. The grant binds to that organization.
- User connection binds to the caller. A callback grant opens only when the signed state names the caller.
- Webhook delivery exposes the App webhook secret first. It binds organization effects only after the plugin verifies the signature.

### Why the webhook is not signed ingress

The GitHub webhook uses a bound public route, not the `signature` pipeline.
GitHub signs per App, so the host resolves one App secret before it knows an organization. With only the `GITHUB_APP_*` fallback, the verified installation ID selects the organization.
The `signature` pipeline writes a drop-log row for each bad signature, and it acknowledges a verified malformed body with its acknowledgement status.
The GitHub route keeps its throttled warning, writes nothing for a bad signature, and returns 400 for a verified body that is not JSON.
Verified deliveries also update installation rows, content sources, and pull request state. The `signature` pipeline only emits events.

### Behavior changes

- Authenticated GitHub routes now require current organization membership, the same as other plugin routes.
- Authenticated GitHub routes now have body caps: 0 bytes for GET and DELETE, and 64 KiB for POST. Before, they had no cap.
- The webhook enforces its 1 MiB cap while it reads the stream.
- A manifest request with a JSON `null` body now uses the defaults. Before, it failed with HTTP 500.
- The routes exist only when the GitHub plugin is loaded. Bundled plugins always load, so deployments keep every URL.

### Not moved

The shared App client stays in `packages/api/src/services/github-app.ts`. Token resolution, the installation sweep, and boot webhook sync use its JWT minting, installation discovery, and webhook URL sync.
Installation rows stay in `github_installations`, and App credentials stay in `credentials`. TKAI-378 decides plugin-owned storage.
The single-App caveat remains. If two organizations store an App in one deployment, webhook deliveries go to the first credential row.

## Linear connection binding

The Linear plugin declares GET, PUT, and DELETE `/connection` as organization-admin routes.
The canonical URL is `/api/plugins/linear/http/connection`.
PUT accepts at most 1 MiB. GET and DELETE accept no body.

The plugin exports a handler factory and the `LinearConnectionCapability` type.
The factory receives only a capability and endpoint configuration: the public URL and the Linear API origin.
The host always supplies the Linear API origin from `LINEAR_API_URL` or the public default. The plugin has no default, so a fixture override also covers the pasted client secret.
The capability has `status`, `save`, `legacyWebhooks`, and `disconnect`. No method takes an organization or user ID.

The plugin owns secret validation, the token request, the workspace lookup, refusal messages, setup URL presentation, and legacy webhook deletion.
`packages/api/src/plugins/http-linear-connection.ts` binds the three route IDs through the host bindings described above.
After the mount checks identity, membership, administration, and the body limit, the binding calls `createLinearConnectionCapability`.
That capability binds the existing tables to the caller's organization and user. The binding then runs the factory's handler for the route ID.
The plugin's declared handlers never receive the capability. They answer 501 on a host without the bindings.

`save` keeps the organization row lock, the one-workspace conflict check, and the shared connection ID on both credential rows.
`disconnect` deletes the app configuration first, then the installation, then the token.
A failed legacy webhook deletion does not stop the disconnection.

The host keeps GET, PUT, and DELETE `/api/org/linear` as aliases in `LEGACY_ROUTES`. Each alias pins its method and `org-admin` authentication.
Both URLs share one handler, so status codes, bodies, and errors match.
`app.ts` no longer mounts a Linear router. If the Linear plugin is not loaded, neither URL exists.
The displayed redirect URI stays `/api/org/linear/callback`. It is metadata for Linear's app form, not a browser OAuth flow.
No schema, credential, or installation data changes.
