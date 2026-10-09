# Linear connection route adoption implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task.

**Goal:** Move Linear connection HTTP behavior into the Linear plugin while preserving existing installations and URLs.

**Architecture:** The plugin declares and implements its three connection routes. The API binds narrow persistence methods to the authenticated caller. The existing schema, credential refresh owner, and transaction remain in the API adapter.

**Tech Stack:** TypeScript, Hono, Drizzle, Vitest, portable Request and Response types.

**Spec:** ../specs/2026-10-07-plugin-http-interfaces-design.md

## Global constraints

- No Hono, database, or API package imports in plugin code.
- No schema changes, data resets, credential migration, or ticket updates.
- Keep GET, PUT, and DELETE `/api/org/linear` as compatibility aliases.
- Add GET, PUT, and DELETE `/api/plugins/linear/http/connection` as canonical routes.
- Require organization administration before binding capabilities or making provider calls.
- Keep the current client-credentials grant. The displayed callback URI remains metadata; it is not a browser OAuth flow.
- Keep `/webhooks/events/linear` and its signature behavior unchanged.
- Bind every persistence operation to the host-derived organization and user. Request JSON cannot choose either identity.

## Review focus

- Malformed or oversized requests must not call Linear or write credentials.
- A foreign organization identifier in JSON must not affect storage ownership.
- Concurrent reconnects must retain the organization row lock and connection ID fence.
- Legacy webhook cleanup failure must not prevent disconnection.
- Disabled or replaced plugins must not leave manual routes mounted by `app.ts`.

## Task 1: Move the provider client without changing its consumers

Files: create `packages/plugin-linear/src/service.ts`; export it from `packages/plugin-linear/package.json`; replace `packages/api/src/services/linear.ts` with a compatibility re-export.

- [x] Copy the Linear client, token error, scopes, and resource types into the plugin.
- [x] Replace `NodeJS.ProcessEnv` with `{ LINEAR_API_URL?: string }`. Preserve the default endpoint and injectable fixture URL.
- [x] Keep the host compatibility module so token renewal and existing tests use the same error constructor.
- [x] Run `pnpm --filter @valet/plugin-linear test`, `pnpm --filter @valet/api test linear-connect linear-app-token-store`, and `pnpm typecheck`.
- [x] Commit the client relocation with a matching spec note.

## Task 2: Bind a narrow connection adapter

Files: create `packages/plugin-linear/src/connection.ts` and `packages/api/src/plugins/http-linear-connection.ts`; update `packages/api/src/plugins/http-bindings.ts`.

The plugin exports the connection capability types and a route factory. The capability contains these methods, with no caller IDs in their arguments:

```ts
interface LinearConnectionCapability {
  status(): Promise<LinearConnectionStatus>;
  save(input: LinearConnectionSave): Promise<{ conflictWorkspaceName: string } | null>;
  legacyWebhooks(): Promise<{ accessToken: string; webhookIds: string[] } | null>;
  disconnect(): Promise<void>;
}
```

`LinearConnectionStatus` contains the existing configured, clientId, connected, webhookConfigured, ready, workspaceName, and reason fields.
`LinearConnectionSave` contains clientId, clientSecret, webhookSecret, accessToken, expiresAt, workspaceId, and workspaceName.

- [x] Add canonical-route tests alongside each existing legacy connection test.
- [x] Add a request with `orgId: "foreign"`; assert the installation and both credentials belong to the authenticated organization.
- [x] Implement `save` with the existing organization row lock, workspace conflict check, credential replacement, shared connection ID, and installation upsert.
- [x] Implement `disconnect` with the existing app-config-first ordering, installation removal, and token deletion.
- [x] Bind the adapter only after the generic route mount completes identity, membership, admin, and request-size checks.
- [x] Register the three bundled Linear route IDs in the host binding table that Slack and GitHub use. Each binding pins the declared method, path, and authentication. The plugin route factory receives only the scoped capability and endpoint configuration.
- [x] Add a binding test that verifies unauthorized requests cannot invoke the adapter.

## Task 3: Move connection behavior and remove manual mounting

Files: update `packages/plugin-linear/src/plugin.ts`, `packages/api/src/plugins/http-routes.ts`, and `packages/api/src/app.ts`; remove `packages/api/src/routes/linear-connect.ts`.

- [ ] Move secret validation, token request, workspace lookup, refusal messages, URL presentation, and legacy webhook deletion into the plugin factory.
- [ ] Declare three org-admin routes at `/connection`; retain a 1 MiB body cap for PUT and zero-byte caps for GET and DELETE.
- [ ] Add fixed method-and-auth compatibility aliases for `/api/org/linear`.
- [ ] Delete the manual Linear router import and mount from `app.ts`.
- [ ] Preserve every existing response status, body field, error action, and client-credentials scope.
- [ ] Run the Linear connection, token-store, webhook, plugin-mount, and loader tests.
- [ ] Run typecheck and the full `make e2e` scorecard.
- [ ] Review the diff, update the HTTP design spec, and create a stacked PR. Do not merge either PR.

## Remaining provider adoption

GitHub: personal connect, organization status, callback, disconnect; organization app status, manifest, setup, credential, refresh, disconnect; public app webhook. Preserve signed state, the callback user, installation ownership, and webhook deduplication.

Slack: organization app status and the shared Events API/interactivity webhook. Preserve challenge responses, signature verification, durable inbox admission, retry ownership, channel consumers, and event fan-out. See [the Slack adoption plan](2026-10-09-slack-plugin-adoption.md).

Security: the session-scoped Security routes in `packages/api/src/routes/security.ts`, including preview, execution, findings, coverage, exports, handoffs, issue publication, cancellation, and resume. Preserve session authorization and relational persistence through narrow domain capabilities.

TKAI-378, TKAI-379, and TKAI-380 remain separate storage, lifecycle, and typed-event work. This plan does not complete those tickets or all of TKAI-377.
