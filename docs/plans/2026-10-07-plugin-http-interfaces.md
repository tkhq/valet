# Plugin HTTP interfaces implementation plan

**Goal:** Deliver the first working TKAI-377 iteration, with Linear ingress using the new contract.

**Architecture:** Plugins declare portable routes. The API host validates, mounts, authenticates, and bounds requests. The Linear plugin verifies deliveries. The host resolves existing installation records and persists verified events.

**Spec:** ../specs/2026-10-07-plugin-http-interfaces-design.md

**Execution:** Implement in this session and iterate, as requested. This iteration does not complete all four Linear tickets.

## Constraints

- Preserve `/webhooks/events/linear`, signatures, HTTP 200 acknowledgements, deduplication, and dispatch.
- Preserve current Linear client-credentials setup and every stored installation.
- No Hono or database imports in the plugin contract.
- No schema changes or database resets.
- Authenticated routes derive identity from host authentication and membership checks.
- Public routes have no authenticated host capabilities.

## Tasks

- [x] Add portable route types and descriptor validation in `packages/engine/src/plugin-http.ts`.
  Expose `ValetPlugin.httpRoutes`. Test invalid paths, authentication modes, duplicate IDs and ambiguous paths.
- [x] Add generic mounting in `packages/api/src/plugins/http-routes.ts`.
  Mount public routes before authentication and authenticated routes after it. Reject oversized streaming bodies before executing handlers.
  Test absent identity, revoked membership, non-admin callers, team principals, raw bytes, and parameter extraction.
- [x] Add Linear's signed ingress descriptor in `packages/plugin-linear/src/http.ts`.
  Move payload parsing and trigger selection out of the API router. Preserve rejection and acknowledgement behavior.
- [x] Add the existing-table adapter in `packages/api/src/plugins/http-installations.ts`.
  Resolve the external workspace to its stored org and read only that org's signing metadata. Never refresh tokens on ingress.
- [x] Replace the provider branch in `routes/event-webhooks.ts` with registry mounting in `app.ts`.
  Keep the old URL as a host-owned alias. Test the canonical and legacy URLs against the same persisted dedupe key.
- [x] Run focused tests, typecheck, and full `make e2e`. Inspect the diff and document remaining adoption work.

## Review focus

- Unknown installations must receive the provider acknowledgement without dispatch.
- Correctly signed unsupported events must not trigger provider retries.
- Invalid signatures must not refresh credentials or emit events.
- Chunked requests and false lengths must not bypass body limits.
- User-supplied organization IDs must not replace authenticated route identity.

## Remaining iterations

Migrate Linear connection routes, GitHub, Slack, and Security through narrow capabilities. Then address storage, lifecycle, and typed event contracts. Do not mark TKAI-377 complete until its named route families use the registry.

## Validation result

Focused API suites: 63 passed. Engine route and manifest suites: 63 passed.
Full `make e2e`: 21 passed, 0 failed, 16 environment-dependent skips.
Direct review found and fixed response-constructor identity checks and diagnostic ownership spread.
The independent reviewer could not start because the session reached its agent limit.
