# Slack setup and signed ingress adoption implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task.

**Goal:** Move Slack setup and signed ingress HTTP behavior into the Slack plugin while every existing URL, acknowledgement, and durable inbox consumer stays unchanged.

**Architecture:** The plugin declares two routes and owns the Slack protocol. That includes the URL verification handshake, v0 signature checks over raw bytes, payload parsing, retry headers, response codes, and the manifest. The API binds each route to one request-scoped capability. The durable inbox, its drain, and its three consumers stay in the API.

**Tech Stack:** TypeScript, Hono, Drizzle, Vitest, portable Request and Response types.

**Spec:** ../specs/2026-10-07-plugin-http-interfaces-design.md (adoption step 5)

## Global constraints

- No Hono, database, or API package imports in plugin code.
- No schema changes, data rewrites, credential migration, or ticket updates.
- Keep POST `/api/channels/slack/webhook` and GET `/api/org/slack` as compatibility URLs with fixed method and authentication.
- Add POST `/plugins/slack/http/events` and GET `/api/plugins/slack/http/app` as canonical routes.
- Keep the manifest request URL at `/api/channels/slack/webhook`. Installed Slack apps call that URL.
- Pass raw body bytes and signature headers to the plugin unchanged.
- Select the organization in the host. No capability method accepts an organization or user ID.
- Save the encrypted request in `slack_webhook_inbox` before the 200 acknowledgement.

## Route inventory

| Route | Auth | Owner after this plan | Notes |
| --- | --- | --- | --- |
| POST `/api/channels/slack/webhook` | Slack v0 signature | Plugin `events` route, host alias | Events API JSON and interactivity forms. 1 MiB cap. |
| GET `/api/org/slack` | Org admin | Plugin `app` route, host alias | Manifest, request URL, connection state, missing scopes. |
| PUT and DELETE `/api/credentials/slack?scope=org` | Org admin for org scope | Host (stays) | Generic credential routes for all services. |
| GET `/api/credentials/slack-user/connect`, GET `/api/credentials/oauth/callback` | User, OAuth state | Host (stays) | Generic OAuth for all declared services. |
| `/api/me/identity-links/:provider/*` | User | Host (stays) | Generic pairing for every `identityLink` plugin. |
| GET `/avatars/*` | Public | Host (stays) | Slack reads assistant icons. Not Slack-specific. |
| Socket Mode | App token | Transport (stays) | Not HTTP. |

### Ingress behavior that must not change

1. The host rejects a body above 1 MiB with 413 `{"error":"payload too large"}`. It checks Content-Length, then the streamed bytes.
2. A `url_verification` JSON body gets 200 `{"challenge":...}` before any credential read. A challenge above 512 characters gets 400 `{"error":"challenge too long"}`. A form body is never a handshake.
3. `X-Slack-Retry-Num` writes a throttled `slack_retry` diagnostic without delay to the response. A malformed number becomes `unknown`. An unknown reason becomes `unknown`.
4. No org credential, signing secret, or team ID gives 200 with an empty body and a throttled `unknown_org` diagnostic.
5. A stopped Slack transport gives 503, `Retry-After: 5`, and `{"error":"Slack is starting. Retry this delivery shortly."}`. The route admits nothing.
6. A bad signature, a missing header, a crafted header, or a timestamp outside 300 seconds gives 401 `{"error":"signature verification failed"}` and a throttled `bad_signature` diagnostic.
7. The host saves a verified request, encrypted, with ID `sha256(orgId + ":" + rawBody)` and `ON CONFLICT DO NOTHING`. The route then nudges the dispatcher and returns 200 with an empty body.
8. If the insert fails, the route returns 500, so Slack retries.

### Inbox consumers that must not change

`drainSlackIngress` leases due rows, re-checks the connected team, and writes receipts. It sends each update to the channel host, to the Slack trigger definitions with `ingestEvent`, and to the follow router. Ingest deduplicates on `(service, dedupe_key)`. The engine deduplicates channel dispatch on `(session_id, dispatch_id)`. The drain rejects a foreign workspace with a receipt and a `foreign_workspace` diagnostic. After 10 attempts, the drain marks the row failed and records a `slack_delivery_failed` problem.

## Review focus

- A request body cannot select the organization, the secret, or the stored bytes.
- Unsigned requests must not reach `admit`.
- Unauthorized setup calls must not read the credential.
- The compatibility URL must win over the generic `/api/channels/:channelType/webhook` route.
- The stored inbox headers no longer contain Cookie, Authorization, or Valet credential headers. Slack sends none of them, and the drain reads only the Slack signature headers.

## Task 1: Pin parity against the manual mounts

Files: create `packages/api/src/plugins/http-slack.test.ts`.

- [x] Pin each ingress status, body, and header listed above, including a streamed oversized body and retry deduplication.
- [x] Pin the setup response, the non-admin 403 body, anonymous 401, and the team API key 403.
- [x] Run the suite against the manual mounts.

## Task 2: Move the app contract and the protocol into the plugin

Files: move `packages/api/src/services/slack-app.ts` to `packages/plugin-slack/src/app-manifest.ts`; create `packages/plugin-slack/src/http.ts`; update `transport/verify.ts`, `transport/transport.ts`, `plugin.ts`, and `package.json`.

- [x] Move scopes, bot events, scope helpers, and the manifest builder. The host passes the request URL, the OAuth callback URL, and the user scopes.
- [x] Keep `services/slack-app.ts` as a host module for URLs and compatibility re-exports.
- [x] Share `verifySlackDelivery` between the transport and the `events` route.
- [x] Declare `events` (public, POST, 1 MiB) and `app` (org admin, GET, 0 bytes). Without a host binding, both return 501.

The plugin exports these capabilities:

```ts
interface SlackIngressCapability {
  connection(): Promise<{ state: "unconfigured" } | { state: "starting" } | { state: "ready"; signingSecret: string }>;
  report(problem: SlackIngressProblem): Promise<void>;
  admit(delivery: { updates: RawChannelUpdate[]; retryNum?: string; retryReason: string }): Promise<void>;
}
interface SlackSetupCapability {
  connection(): Promise<{ teamName?: string; teamId?: string; grantedScopes?: string[] } | null>;
  endpoints(): { requestUrl: string | null; oauthRedirectUrl: string | null; userScopes: readonly string[] };
}
```

## Task 3: Bind host capabilities and remove manual mounts

Files: create `packages/api/src/plugins/http-bindings.ts` and `http-slack.ts`; move `routes/slack-webhook.ts` to `channels/slack-inbox.ts`; delete `routes/slack-app.ts`; update `http-routes.ts`, `app.ts`, and `main.ts`.

- [x] Add a host-owned binding map by plugin name and route ID. A binding declares its authentication, and mounting fails on a mismatch.
- [x] Run bindings only after the generic identity, membership, administration, and body-limit checks.
- [x] Make every compatibility URL fix its method and authentication.
- [x] Mount public plugin routes before `channelsRouter`.
- [x] Keep `admitSlackDelivery`, the drain, and its consumers in `channels/slack-inbox.ts`.
- [x] Run the parity suite on both URL sets, the inbox suite, the route-mount suite, the plugin suite, typecheck, and `make e2e`.

## Remaining Slack work

- Org credential connect stays in the generic credential routes until TKAI-379 defines credential enrichment hooks.
- Identity linking and user OAuth stay generic host routes.
- Pointing new manifests at the canonical URL is a separate decision. It changes what operators install.
- The inbox table and its drain move only with TKAI-378 storage work.
