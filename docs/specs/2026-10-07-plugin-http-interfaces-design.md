# Plugin HTTP interfaces

Status: first iteration implemented for TKAI-377. Provider adoption remains in progress.

## Intent and scope

Plugins must own provider-specific HTTP behavior. The host must enforce authentication, tenant boundaries, request limits and mounting rules.

The starting ticket is [TKAI-377](https://linear.app/turnkey/issue/TKAI-377). Its companions are [storage](https://linear.app/turnkey/issue/TKAI-378), [lifecycle hooks](https://linear.app/turnkey/issue/TKAI-379) and [event production](https://linear.app/turnkey/issue/TKAI-380).

Existing webhook URLs, OAuth callbacks, saved credentials, installation records and subscription behavior must remain compatible. No installation or user data is deleted.

## Current evidence

- `packages/engine/src/valet-plugin.ts` has no HTTP route declaration.
- `packages/api/src/app.ts` explicitly mounts Slack, GitHub, Linear and Security route families.
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

This iteration does not move connection handlers, GitHub, or Security routes. The Slack section below describes the Slack adoption.
It does not implement arbitrary callback state capabilities, plugin-owned storage, lifecycle hooks, or the complete event-emission interface.
New signed plugins currently need an installation adapter. This restriction remains until plugin-owned installation storage is available.
No database migration or existing-data rewrite is required.

## Host compatibility checks

The node_modules loader quarantines signed-route plugins when no host installation resolver exists. Other plugins continue to load.
Route mounting retains its defensive check for invalid host configuration.

The host removes Cookie, Authorization, X-API-Key, X-Valet-Sandbox, X-Valet-Internal, and X-Valet-Test-User-ID headers before invoking plugin code.
Authenticated routes receive caller identity through the caller argument. Provider signatures must use separate headers, such as Linear-Signature.
Signature headers and raw body bytes remain unchanged.

## Linear client preparation

The Linear plugin owns the provider HTTP client for token creation, workspace lookup, and legacy webhook deletion.
The API compatibility module keeps host environment defaults and shares the plugin's token error constructor.
Connection route mounting, persistence, and token renewal ownership remain in the API host.
The next adoption step is described in [the Linear adoption plan](../plans/2026-10-08-linear-plugin-adoption.md).
This preparation does not complete Linear connection route adoption or TKAI-377.

## Slack adoption

The Slack plugin declares two routes. `events` is a public POST route with a 1 MiB limit. `app` is an org-admin GET route.
The host keeps POST `/api/channels/slack/webhook` and GET `/api/org/slack` as compatibility URLs.
Each compatibility URL fixes its method and authentication. Public plugin routes mount before the generic channel webhook route, so the Slack URL still wins.

The plugin owns the URL verification handshake, v0 signature verification over raw bytes, payload parsing, retry headers, response codes, and the app manifest.
The host passes the manifest URLs and the Slack user scope bundle as endpoint configuration.

Bundled routes that need host data use a host-owned binding map, keyed by plugin name and route ID.
A binding declares its authentication, and mounting fails on a mismatch. The host runs the binding after its authentication and body-limit checks.
Each binding gives the handler one request-scoped capability. No capability method accepts an organization or user ID.

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
