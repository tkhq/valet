# GitHub plugin route adoption implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task.

**Goal:** Move GitHub's App setup, user connection, and App webhook handlers into the GitHub plugin while every existing URL keeps its behavior.

**Architecture:** The plugin declares eleven routes and exports a handler for each. The handlers own request parsing, provider calls, signature verification, and responses. A host binding table gives each handler narrow capabilities that the API binds to the authenticated caller, the signed state, or the App owner. Storage, state signing, and the shared App client remain in the API.

**Tech Stack:** TypeScript, Hono, Drizzle, Vitest, portable Request and Response types.

**Spec:** ../specs/2026-10-07-plugin-http-interfaces-design.md

## Global constraints

- No Hono, database, or API package imports in plugin code.
- No schema changes, data resets, credential migration, or ticket updates.
- Keep every legacy URL in the table below as a fixed host alias with the same method and authentication.
- Keep the URLs that GitHub Apps already store. The manifest still names `/api/org/github-app/setup`, `/api/me/github/callback`, and `/webhooks/github-app`.
- Keep raw-byte HMAC verification of `X-Hub-Signature-256`. The host does not decode the body before the plugin verifies it.
- Bind every persistence operation to a host-derived organization or user. Request JSON and query strings cannot choose either identity.
- Installation rows stay in `github_installations` and App credentials stay in `credentials`. TKAI-378 decides plugin-owned storage.

## Route inventory

Canonical authenticated routes use the `/api/plugins/github/http` prefix. The public webhook uses `/plugins/github/http/webhook`.

| ID | Method | Legacy URL | Canonical path | Auth | Body cap |
| --- | --- | --- | --- | --- | --- |
| `app-status` | GET | `/api/org/github-app` | `/app` | org admin | 0 |
| `app-manifest` | POST | `/api/org/github-app/manifest` | `/app/manifest` | org admin | 64 KiB |
| `app-setup` | GET | `/api/org/github-app/setup` | `/app/setup` | user, signed state | 0 |
| `app-credential` | POST | `/api/org/github-app/credential` | `/app/credential` | org admin | 64 KiB |
| `app-refresh` | POST | `/api/org/github-app/refresh` | `/app/refresh` | org admin | 64 KiB |
| `app-disconnect` | DELETE | `/api/org/github-app` | `/app` | org admin | 0 |
| `connect` | POST | `/api/me/github/connect` | `/connection/connect` | user | 64 KiB |
| `org-status` | GET | `/api/me/github/org-status` | `/connection/org-status` | user | 0 |
| `callback` | GET | `/api/me/github/callback` | `/connection/callback` | user, signed state | 0 |
| `disconnect` | DELETE | `/api/me/github` | `/connection` | user | 0 |
| `webhook` | POST | `/webhooks/github-app` | `/webhook` | public, App HMAC | 1 MiB |

Responses that must not change:

- `app-status`, `app-credential`, and `app-refresh` return `GetGithubAppResponse`. A failed refresh returns 502 `failed to refresh installations from GitHub`. A non-admin gets 403 `org admin required`.
- `app-manifest` returns `{ url, manifest, state }`. Invalid permission levels or event names return 400.
- `app-setup` returns 400 for a missing code or state, and for an invalid or expired state. It returns 409 when GitHub rejects the code and 502 for GitHub outages or malformed replies. Success is a 302 to `<returnTo>/settings/organization/github?setup=ok`.
- `app-credential` returns 400 with the existing corrective messages for a non-JSON body, missing fields, a non-PEM key, a key GitHub rejects, and a missing slug.
- `app-disconnect` and `disconnect` return 204 with no body.
- `connect` returns 409 when the organization has no App, otherwise `{ url }`.
- `callback` returns 400 for a missing, invalid, or foreign state, 409 with no App, 400 or 502 for token exchange failures, and a 302 to the settings or Integrations page.
- `webhook` returns 413 above 1 MiB, 204 when no App exists, 403 `signature verification failed`, 400 `invalid JSON` after a valid signature, and 204 for every handled delivery.

Existing suites: `routes/github-app.test.ts`, `routes/github-connect.test.ts`, `routes/readiness-mutations.test.ts`, `routes/repos.test.ts`, `routes/events.e2e.test.ts`, and `integration/github-repo.e2e.test.ts`.

## Review focus

- Unauthenticated, non-member, and non-admin requests must not reach plugin code or capabilities.
- A forged, expired, or foreign state must not write a credential or call GitHub.
- An unsigned or mis-signed webhook must not read installations, write rows, or call GitHub.
- A webhook-less App stores an empty secret. An empty secret must never verify.
- A disabled or replaced plugin must not leave manual GitHub routes in `app.ts`.

## Task 1: Pin parity on the legacy mounts

Files: create `packages/api/src/routes/github-http-parity.test.ts`.

- [x] Add a request table for each legacy URL: unauthorized, non-admin, malformed, and success cases with exact status and body.
- [x] Add a chunked webhook body above 1 MiB with no Content-Length. Assert 413 and no side effects.
- [x] Run the table on the legacy routers. All legacy rows pass. Canonical rows fail with 404, except the unauthenticated row. The host authentication middleware answers that row first.

## Task 2: Bind GitHub routes through the host binding table

Files: update `packages/api/src/plugins/http-routes.ts` and `packages/api/src/plugins/http-bindings.ts`, which the Slack adoption created.

Use the binding table of the Slack adoption, so the provider branches stack. A binding is keyed by plugin name and route ID. It names the authentication it requires and returns the response.

- [x] Run a binding only where the mount would call the manifest handler: after identity, membership, administration, and body-size checks.
- [x] Refuse to mount a binding whose authentication differs from the declaration.
- [x] Pin each compatibility URL to one method and one authentication.
- [x] Answer 501 from the manifest handlers, so a host without the binding fails closed.

## Task 3: Move the handlers into the plugin

Files: create `packages/plugin-github/src/http/*.ts`; create `packages/api/src/plugins/http-github.ts` and register `githubHttpBindings` in `http-bindings.ts`; update `packages/api/src/app.ts`; delete `packages/api/src/routes/github-app.ts` and `packages/api/src/routes/github-connect.ts`.

The plugin exports these capability interfaces. No method takes a user or organization ID.

```ts
interface GithubAppCapability {
  status(): Promise<GithubAppStatus>;
  orgName(): Promise<string>;
  signSetupState(): string;
  checkCredential(credential: { appId: string; privateKeyPem: string }): Promise<GithubAppCredentialCheck>;
  saveApp(input: GithubAppConfigInput): Promise<void>;
  refreshInstallations(): Promise<boolean>;
  disconnect(): Promise<void>;
}
interface GithubSetupCapability { open(state: string): GithubSetupGrant | null }
interface GithubConnectionCapability {
  oauthClientId(): Promise<string | null>;
  signConnectState(postAuthDestination?: 'integrations'): string;
  orgStatus(): Promise<GithubOrgStatus>;
  openCallback(state: string): GithubCallbackOpening;
  disconnect(): Promise<void>;
}
interface GithubWebhookCapability { openDelivery(): Promise<GithubWebhookDelivery | null> }
```

- [x] Move manifest construction, conversion parsing, credential form parsing, OAuth code exchange, profile lookup, and redirects into the plugin.
- [x] Move HMAC verification, payload parsing, push and pull request parsing, installation event handling, and trigger selection into the plugin.
- [x] Bind App capabilities to the caller's organization, the setup grant to the signed state's organization, and the callback grant to the caller only when the state names the caller.
- [x] Bind webhook effects only after the plugin verifies the signature. Resolve the organization from the App credential owner or the environment fallback, as before.
- [x] Delete the manual GitHub imports and mounts from `app.ts`.
- [x] Run the GitHub, readiness, repository, event, plugin-mount, and loader suites.

## Task 4: Verify and document

- [x] Update the HTTP design spec in the same commit as the move.
- [x] Run `pnpm typecheck` and the targeted suites.
- [ ] Run the full `make e2e` scorecard. The stack coordinator runs it serially.

## Not moved

- The shared App client stays in `packages/api/src/services/github-app.ts`. Token resolution, the installation sweep, and boot webhook sync use JWT minting, installation discovery, and webhook URL sync. A later step can move it the way Linear's client moved.
- The webhook uses a bound public route, not the generic signed-ingress pipeline. GitHub signs per App, and the organization comes from the App owner. The generic pipeline writes a drop-log row for each bad signature and acknowledges a verified malformed body with 204. GitHub currently gets a throttled warning and a 400.
