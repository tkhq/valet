# Telegram User Worker Integration

**Status:** Draft
**Author:** Conner Swann
**Date:** 2026-06-05

## Summary

Add a separate `telegram_user` integration that exposes Telegram user-account actions from the Cloudflare Worker. This integration is distinct from the existing `telegram` bot channel plugin. Users connect through a Valet-controlled session generator: they enter their phone number, Telegram code, and 2FA password if needed; the Worker uses a Valet-owned global Telegram application API ID/hash to create a reusable MTProto session string, then stores that session string in the normal encrypted credential store.

All action execution must run inside the Worker. There is no Python service, Node sidecar, Modal process, hosted MCP server, or sandbox dependency. The implementation should use `@mtcute/core` as the MTProto client and provide Valet-owned Cloudflare Worker adapters for platform, crypto, storage, and transport. GramJS, Telethon, TDLib, and Python MCP code are references only.

## Goals

- Add a first-party action plugin for Telegram user accounts with service id `telegram_user`.
- Keep the existing Telegram bot channel integration unchanged.
- Execute all Telegram account actions inside the Cloudflare Worker.
- Use a Valet-controlled session generator for MVP setup.
- Do not support user-imported or externally generated session strings.
- Use a Valet-owned global Telegram app API ID/hash for session generation and action execution.
- Avoid exposing the global Telegram API hash to the browser, users, sandboxes, logs, or local helper scripts.
- Keep protocol, action, schema, and Telegram-specific credential handling self-contained in `packages/plugin-telegram-user/` where possible.
- Use `@mtcute/core` for MTProto behavior, while keeping all Cloudflare Worker runtime bindings inside the plugin.
- Require stable egress through a configured external proxy in production.
- Start with a small, policy-friendly tool set: read chats/messages, search messages, send/reply, and mark read.

## Non-Goals

- Replacing the existing `telegram` channel plugin.
- Requiring users to create Telegram developer applications.
- Accepting externally generated Telegram session strings.
- Publishing or distributing Valet's Telegram API hash.
- Running any Telegram code in Valet sandboxes.
- Hosting a separate MCP or Node service for Telegram.
- Full Telethon parity in the first version.
- Using `@mtcute/node`, `@mtcute/deno`, `@mtcute/bun`, TDLib, Telethon, or GramJS as production runtime dependencies.
- Building a full native MTProto client unless the mtcute Worker adapter path fails verification.
- Secret chats, calls, bot management, profile/privacy mutation, group admin tooling, or media upload/download in MVP.
- Long-lived global Worker sockets shared across requests.

## Current State

### Existing Telegram Integration

`packages/plugin-telegram/` is a channel plugin built on the Telegram Bot API. It validates a bot token with `getMe`, stores a `bot_token`, registers a webhook, and routes inbound Telegram messages into Valet sessions. It is not a Telegram user-account integration and cannot read a user's full chat history or act as the user's Telegram account.

### Credential Storage

`storeCredential()` already encrypts arbitrary JSON credential data in the `credentials` table. The stored encrypted payload can contain multiple fields, but `getCredential()` currently normalizes decrypted data into a single `ResolvedCredential.accessToken` by looking for `access_token`, `api_key`, `bot_token`, or `token`. `executeAction()` then converts that resolved credential into `{ access_token }` or `{ bot_token }`.

That normalization is fine for bearer-token services but loses the multi-field shape needed by Telegram user sessions:

```ts
{
  session_string: string;
  session_format: 'mtcute';
  created_by: 'valet_session_generator';
}
```

### Worker Runtime Constraints

Cloudflare Workers support outbound TCP sockets through `connect()` from `cloudflare:sockets`. Sockets must be created inside a handler such as `fetch()`, `scheduled()`, `queue()`, or an alarm; they cannot be created in global scope and shared across requests. Open TCP sockets count toward Worker connection limits.

Cloudflare documentation also states that outbound TCP socket connections are sourced from a prefix that is not part of Cloudflare's published IP ranges. Therefore, if Telegram sessions need stable egress identity, the Worker must connect to an external proxy with stable egress rather than connecting directly to Telegram from arbitrary Worker egress.

Telegram's MTProto transport documentation defines multiple transports, including TCP, WebSocket, HTTP, and HTTPS. This design should prefer the simplest reliable Worker-compatible transport and hide that choice behind a plugin-owned engine interface.

### mtcute Fit

`mtcute` is a good fit if Valet uses its core package instead of a runtime-specific package.

Relevant properties:

- `@mtcute/core` exposes `TelegramClient` and `BaseTelegramClient` constructors that accept injected `storage`, `crypto`, `transport`, and `platform` implementations.
- `@mtcute/core` includes `MemoryStorage`, which is enough for per-action execution when the Worker hydrates the Valet-generated session string at the start of each action.
- `TelegramClient.importSession()` and `TelegramClient.exportSession()` support session-string hydration and finalization, including after a login flow.
- `@mtcute/convert` can convert Telethon, GramJS, Pyrogram, MTKruto, and Telegram Desktop sessions to mtcute's session format, but Valet should not include it in the MVP because user-imported sessions are out of scope.
- `@mtcute/web` proves the browser primitives exist, but its default client depends on IndexedDB and WebSocket transport. The Worker plugin should not use the `@mtcute/web` client directly.

Decision: implement the production engine with `@mtcute/core` plus Valet-owned Worker adapters. Do not implement raw MTProto in the first pass unless the compatibility spike shows `@mtcute/core` cannot bundle or run inside the Worker.

## Design

### Plugin Package

Create `packages/plugin-telegram-user/`.

```text
packages/plugin-telegram-user/
  plugin.yaml
  package.json
  tsconfig.json
  vitest.config.ts
  src/actions/index.ts
  src/actions/provider.ts
  src/actions/actions.ts
  src/actions/credentials.ts
  src/actions/schemas.ts
  src/actions/errors.ts
  src/actions/engine/index.ts
  src/actions/engine/types.ts
  src/actions/engine/mtcute-engine.ts
  src/actions/engine/transport.ts
  src/actions/engine/session.ts
  src/actions/engine/crypto.ts
  src/actions/engine/platform.ts
  src/setup/index.ts
  src/setup/login-flow.ts
  src/setup/pending-login.ts
```

`plugin.yaml`:

```yaml
name: telegram-user
version: 0.0.1
description: Telegram user account actions over MTProto
icon: "TG"
```

The package exports `./actions` and is registered like other action plugins by `make generate-registries`.

Package dependencies:

```json
{
  "dependencies": {
    "@valet/sdk": "workspace:*",
    "@mtcute/core": "^0.29.7",
    "@mtcute/wasm": "^0.29.0",
    "@fuman/net": "0.0.19",
    "zod": "^3.22.4"
  }
}
```

Do not depend on `@mtcute/node`, `@mtcute/web`, `@mtcute/deno`, or `@mtcute/bun` from the Worker plugin. Copy or adapt small platform-binding ideas from those packages only when their licenses permit it and the code remains Worker-native.

### Service Identity

Use service id `telegram_user`.

Rationale:

- Avoids collision with the existing `telegram` Bot API channel service.
- Makes action policy, credential rows, integration rows, audit logs, and disabled-action state unambiguous.
- Lets a user connect both "Telegram Bot" and "Telegram User Account" at the same time.

### Provider

The provider is a native session-style integration, not OAuth, MCP, bot-token, or user-supplied API-key auth.

```ts
export const telegramUserProvider: IntegrationProvider = {
  service: 'telegram_user',
  displayName: 'Telegram User Account',
  authType: 'api_key',
  supportedEntities: ['account', 'chats', 'messages'],
  validateCredentials,
  testConnection,
};
```

`validateCredentials()` checks the local shape only:

- `session_string` is a non-empty string.
- `session_format` is `mtcute`.
- `created_by` is `valet_session_generator`.
- No credential-level proxy, API ID, or API hash fields are accepted.

`testConnection()` creates an engine session and calls `get_me`. It must redact credentials from all errors.

### Credential Schema

Credentials generated by Valet:

```ts
export interface TelegramUserCredentials {
  session_string: string;
  session_format: 'mtcute';
  created_by: 'valet_session_generator';
}
```

The engine always reads Telegram application credentials from Worker secrets:

- `TELEGRAM_USER_API_ID`
- `TELEGRAM_USER_API_HASH`

The encrypted credential payload must not include `api_id` or `api_hash`. Valet does not accept externally generated sessions because doing so would require either user-owned Telegram developer credentials or disclosing Valet's global API hash.

### Session Generator

The setup flow is a Valet-controlled login wizard backed by Worker routes. It uses mtcute authorization methods directly rather than `TelegramClient.start()` so state transitions are explicit.

Routes:

| Route | Purpose |
|-------|---------|
| `POST /integrations/telegram_user/login/start` | Accept phone number, call `sendCode`, create encrypted pending-login state. |
| `POST /integrations/telegram_user/login/verify-code` | Accept pending login id and Telegram code, call `signIn`. |
| `POST /integrations/telegram_user/login/verify-password` | Accept pending login id and 2FA password, call `checkPassword`. |
| `POST /integrations/telegram_user/login/resend-code` | Resend a code for a valid pending login when Telegram allows it. |
| `DELETE /integrations/telegram_user/login/:id` | Cancel and delete pending-login state. |

Pending-login D1 table:

```sql
CREATE TABLE telegram_user_pending_logins (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  encrypted_state TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('code_sent', 'password_required')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX telegram_user_pending_logins_user
  ON telegram_user_pending_logins(user_id, expires_at);
```

Encrypted pending state:

```ts
export interface TelegramPendingLoginState {
  phone_number: string;
  phone_code_hash: string;
  mtcute_session_string: string;
  code_type: string;
  next_type?: string;
  attempts: number;
}
```

Generator flow:

1. `login/start` creates an mtcute client with `MemoryStorage`, Valet Worker API credentials, Worker crypto, and the configured proxy transport.
2. The Worker calls `sendCode({ phone })`.
3. The Worker calls `exportSession()` and stores the pending mtcute session string with `phone_code_hash` in `telegram_user_pending_logins`.
4. `login/verify-code` loads the pending state, imports the pending session into a fresh mtcute client, and calls `signIn({ phone, phoneCodeHash, phoneCode })`.
5. If Telegram returns `SESSION_PASSWORD_NEEDED`, the Worker exports the still-pending session, updates the pending row to `password_required`, and asks the UI for the password.
6. `login/verify-password` imports the pending session and calls `checkPassword(password)`.
7. On successful authorization, the Worker calls `exportSession()` and stores the final `TelegramUserCredentials` in the encrypted `credentials` table with provider `telegram_user`.
8. The Worker upserts the `integrations` row as active and deletes the pending-login row.

Pending-login constraints:

- TTL is 10 minutes from the latest successful state transition.
- At most one active pending login per user; starting a new login deletes the previous pending row.
- Limit code/password attempts to reduce accidental lockouts.
- Delete pending state on success, cancellation, expiry, and definitive Telegram auth failure.
- Do not send `mtcute_session_string`, `phone_code_hash`, API hash, auth keys, or proxy credentials to the browser.

MVP proxy source:

- Use environment-level proxy config for all Telegram user traffic:
  - `TELEGRAM_USER_PROXY_TYPE=socks5`
  - `TELEGRAM_USER_PROXY_HOST`
  - `TELEGRAM_USER_PROXY_PORT`
  - `TELEGRAM_USER_PROXY_USERNAME`
  - `TELEGRAM_USER_PROXY_PASSWORD`

Do not store per-user proxy credentials. A single managed proxy is simpler and matches the "all workers through one external proxy" operating model.

### Raw Credential Resolution

Add a generic platform extension so native action plugins can receive raw encrypted credential fields without bypassing the credential service.

Option A: extend `ResolvedCredential`.

```ts
export interface ResolvedCredential {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  scopes?: string[];
  credentialType: CredentialType;
  refreshed: boolean;
  raw?: Record<string, string>;
  attribution?: { name: string; email: string };
}
```

Then update `buildCredentials()`:

```ts
function buildCredentials(credResult: CredentialResult & { ok: true }): Record<string, string> {
  if (credResult.credential.raw) {
    return {
      ...credResult.credential.raw,
      _credential_type: credResult.credential.credentialType,
    };
  }

  const token = credResult.credential.accessToken;
  const credentials = credResult.credential.credentialType === 'bot_token'
    ? { bot_token: token }
    : { access_token: token };
  credentials._credential_type = credResult.credential.credentialType;
  return credentials;
}
```

Option B: add a service-specific credential resolver for `telegram_user` that returns `raw` while still using the normal encrypted credential row.

Recommendation: implement Option A because it is generally useful for native integrations that need structured secrets. Keep the default behavior unchanged for existing providers by only setting `raw` when a provider opts in.

Also add a credential update hook to `ActionContext` so session-backed plugins can persist rotated session metadata without direct DB access:

```ts
export interface ActionContext {
  // existing fields...
  updateCredentials?(next: IntegrationCredentials): Promise<void>;
}
```

The Worker action runner supplies `updateCredentials()` for built-in providers by calling `storeCredential()` with the same owner, provider, credential type, scopes, and metadata. `telegram_user` uses this only after a successful mtcute call and only when `exportSession()` differs from the stored `session_string`.

### Credential Storage Type

The generic integration configure path currently stores credentials with `credentialType: 'oauth2'`. For `telegram_user`, store `credentialType: 'api_key'` or a new `credentialType: 'session'`.

Recommendation:

- Use existing `api_key` for MVP to avoid a migration solely for enum semantics.
- Store provider metadata indicating the credential is a Telegram session:

```ts
metadata: {
  credentialKind: 'telegram_user_session'
}
```

### Connect UI

Do not use the current token dialog for `telegram_user`. Add a custom connection flow for providers that declare an interactive setup route.

SDK addition:

```ts
export interface IntegrationSetupFlow {
  type: 'builtin_route';
  route: string;
}

export interface IntegrationProvider {
  // existing fields...
  readonly setupFlow?: IntegrationSetupFlow;
}
```

`telegram_user` declares:

```ts
setupFlow: {
  type: 'builtin_route',
  route: '/integrations/telegram_user/login',
}
```

UI states:

- Phone number input.
- Code delivery confirmation and Telegram code input.
- Optional 2FA password input when the Worker returns `password_required`.
- Success state that marks the integration active.
- Error states for expired code, invalid code, invalid password, flood wait, proxy failure, and missing server configuration.

The UI must never request API ID, API hash, or a session string from the user.

### Engine Interface

The actions depend only on a local engine interface. The production implementation is `MtcuteTelegramEngine`.

```ts
export interface TelegramEngine {
  withSession<T>(
    credentials: TelegramUserCredentials,
    persistence: TelegramSessionPersistence,
    fn: (session: TelegramSession) => Promise<T>,
  ): Promise<T>;

  getMe(session: TelegramSession): Promise<TelegramAccount>;
  listChats(session: TelegramSession, params: ListChatsParams): Promise<TelegramChat[]>;
  getChat(session: TelegramSession, params: GetChatParams): Promise<TelegramChat>;
  getMessages(session: TelegramSession, params: GetMessagesParams): Promise<TelegramMessagePage>;
  searchMessages(session: TelegramSession, params: SearchMessagesParams): Promise<TelegramMessagePage>;
  sendMessage(session: TelegramSession, params: SendMessageParams): Promise<TelegramSendResult>;
  markAsRead(session: TelegramSession, params: MarkAsReadParams): Promise<TelegramMutationResult>;
}

export interface TelegramSessionPersistence {
  update(next: TelegramUserCredentials): Promise<void>;
}
```

Engine construction:

```ts
export function createTelegramEngine(env: Env): TelegramEngine {
  return new MtcuteTelegramEngine({
    apiId: env.TELEGRAM_USER_API_ID,
    apiHash: env.TELEGRAM_USER_API_HASH,
    proxy: readTelegramProxyConfig(env),
  });
}
```

`MtcuteTelegramEngine.withSession()`:

1. Creates `MemoryStorage`.
2. Creates `WorkerCryptoProvider`.
3. Creates `WorkerPlatform`.
4. Creates `CloudflareTelegramTransport` or `CloudflareSocks5TelegramTransport` depending on proxy config.
5. Creates an mtcute `TelegramClient` from `@mtcute/core/client.js`.
6. Imports `credentials.session_string` with `force: true`.
7. Executes the requested operation.
8. Exports the session string after successful calls and calls `persistence.update()` if mtcute changed DC/session metadata.
9. Destroys the client in `finally`.

`MtcuteTelegramEngine` should use mtcute high-level methods where they match the action shape:

- `getMe` for `telegram_user.get_me`.
- `iterDialogs` or `getPeerDialogs` for `telegram_user.list_chats`.
- `getChat` or `getPeer` for `telegram_user.get_chat`.
- `getHistory` for `telegram_user.get_messages`.
- `searchMessages` for `telegram_user.search_messages`.
- `sendText` for `telegram_user.send_message`.
- `replyText` for `telegram_user.reply_to_message`.
- `readHistory` for `telegram_user.mark_as_read`.

If a high-level method lacks a needed option, call `client.call()` with the typed raw TL method from mtcute rather than adding native TL serialization to the plugin.

### Transport Strategy

Implement mtcute's `TelegramTransport` interface inside the plugin.

Production transport:

- `CloudflareSocks5TelegramTransport` opens a TCP socket to `TELEGRAM_USER_PROXY_HOST:TELEGRAM_USER_PROXY_PORT` using `connect()` from `cloudflare:sockets`.
- It performs the SOCKS5 handshake inside the Worker.
- It asks the proxy to connect to the Telegram DC address selected by mtcute.
- It uses mtcute's `IntermediatePacketCodec`.

Development/test transport:

- `CloudflareDirectTelegramTransport` can connect directly to Telegram DCs with `cloudflare:sockets`.
- This mode is allowed only when `TELEGRAM_USER_ALLOW_DIRECT_EGRESS=true`.

For stable egress, production must connect to the managed proxy hostname. The proxy then connects to Telegram. The plugin must fail closed if the proxy env vars are missing or invalid in production; it must not silently bypass the proxy.

Supported proxy MVP:

- SOCKS5 over Worker TCP sockets.

Deferred:

- MTProxy.
- HTTP CONNECT proxy.
- Proxy rotation.
- Regional DC pinning.

### Worker Platform Adapters

Implement these adapters in `packages/plugin-telegram-user/src/actions/engine/`.

`WorkerPlatform`:

- Implements mtcute's `ICorePlatform`.
- Returns a stable device model such as `Valet Worker`.
- Reports online status as true inside request handlers.
- Does not read `navigator`, `localStorage`, IndexedDB, filesystem, or Node globals.

`WorkerCryptoProvider`:

- Prefer adapting mtcute's web crypto provider code with `globalThis.crypto.subtle`.
- Bundle the mtcute WASM AES/SHA/gzip module as a Worker-compatible asset or inline module.
- Expose `initialize()` and require the engine to await it before creating the client.
- Do not use Node `crypto`, filesystem, or dynamic remote WASM fetches in production.

`CloudflareSocks5TelegramTransport`:

- Implements mtcute's `TelegramTransport`.
- Wraps Cloudflare TCP sockets in the `@fuman/net` connection shape mtcute expects.
- Handles close/error propagation and abort signals.
- Unit tests use fake readable/writable streams and do not open real sockets.

Fallback:

- If `@mtcute/core` cannot be bundled or executed in the Worker after the compatibility spike, create a follow-up design for a plugin-owned native MTProto implementation. Do not implement raw MTProto in this spec's first milestone.

Compatibility acceptance criteria:

- The Worker bundle contains no Node `net`, `tls`, `fs`, `crypto`, `readline`, SQLite, IndexedDB, `localStorage`, or `navigator` runtime dependency.
- WASM initialization works from a bundled Worker asset or inline module without fetching code from a remote URL.
- A local Worker-runtime test can instantiate the mtcute client, import a known generated session string into `MemoryStorage`, call `getMe` with direct egress enabled, and destroy the client cleanly.
- A separate fake-stream test covers SOCKS5 handshake success and failure without live network access.
- Production configuration without SOCKS5 proxy env vars fails before opening any Telegram connection.

### Session Lifecycle

Do not cache sockets in global scope.

MVP action flow:

1. Resolve raw encrypted credentials for `telegram_user`.
2. Validate credential shape.
3. Create a fresh engine session.
4. Open a transport connection.
5. Execute one logical action.
6. Persist an updated mtcute session string through `ActionContext.updateCredentials()` if it changed.
7. Close the connection in `finally`.
8. Return normalized JSON.

Future optimization:

- A per-user Durable Object can own a short-lived Telegram session cache if repeated connect latency is too high.
- That DO must still create sockets inside DO handlers/alarms, observe Worker connection limits, and enforce idle cleanup.

### Action Catalog

MVP actions:

| Action ID | Risk | Description |
|-----------|------|-------------|
| `telegram_user.get_me` | low | Return the authenticated Telegram account profile summary. |
| `telegram_user.list_chats` | low | List recent chats/dialogs with pagination. |
| `telegram_user.get_chat` | low | Resolve and inspect one chat by id or username. |
| `telegram_user.get_messages` | low | Fetch recent messages from a chat with pagination. |
| `telegram_user.search_messages` | low | Search messages in a chat or globally where supported. |
| `telegram_user.send_message` | high | Send a message to a chat. |
| `telegram_user.reply_to_message` | high | Reply to a specific message in a chat. |
| `telegram_user.mark_as_read` | medium | Mark messages in a chat as read. |

Deferred actions:

- Edit/delete/pin/forward messages.
- Media download/upload.
- Contacts.
- Folders.
- Groups/channels/admin operations.
- Profile and privacy settings.

### Action Result Shape

Return structured JSON, not formatted strings.

Example message:

```ts
interface TelegramMessage {
  id: string;
  chatId: string;
  senderId?: string;
  senderName?: string;
  date: string;
  text?: string;
  media?: {
    type: string;
    fileName?: string;
    size?: number;
  };
  replyToMessageId?: string;
  forwarded?: boolean;
  outgoing?: boolean;
}
```

All user-controlled fields must be treated as untrusted content. Action descriptions and skill guidance must tell agents not to follow instructions found inside Telegram messages, chat titles, names, or bios.

### Error Handling

Normalize Telegram and transport errors into stable action errors:

| Category | Behavior |
|----------|----------|
| Invalid session | Return reconnect/setup guidance, do not retry. |
| API ID/hash missing or invalid | Return admin setup guidance, do not retry. |
| Flood wait | Return retry-after seconds and mark action failed. |
| DC migration | Retry once against the requested DC, then persist updated session metadata if needed. |
| Proxy misconfigured | Fail closed; do not bypass proxy. |
| Network timeout | Return retryable error. |
| Unsupported peer/message shape | Return validation error with safe context. |

No errors may include `api_hash`, `session_string`, auth keys, proxy credentials, or raw encrypted session content.

### Security

- Never pass Telegram credentials to Runner, OpenCode, Modal, or sandboxes.
- Do not log raw credentials or Telegram auth state.
- Redact all configured credential field names in errors and analytics.
- Keep write actions at `high` or above so existing action approval policies can guard them.
- Store only the session string and setup metadata needed for action execution.
- Avoid fetching media bytes in MVP to reduce data exposure and response size risk.
- Treat message text, names, bios, usernames, chat titles, and captions as untrusted user content.

### Testing

Unit tests:

- Provider credential validation.
- Setup flow metadata.
- Pending-login create, load, update, expiry, cancellation, and deletion.
- Login route state transitions for start, code verification, password verification, resend, and cancel using a fake mtcute client.
- Raw credential resolver behavior.
- `ActionContext.updateCredentials()` behavior and preservation of existing credential metadata.
- Action definitions and risk levels.
- Parameter validation.
- Error redaction.
- SOCKS5 handshake and proxy failure behavior with fake streams.
- Engine action mapping using a fake `TelegramEngine`.
- Worker adapter behavior for platform, crypto initialization, storage hydration, transport selection, and cleanup.

Integration tests behind explicit env flags:

- Session generator against a test Telegram account.
- `get_me` against a test Telegram account.
- `list_chats`.
- `get_messages` from Saved Messages or a test chat.
- `send_message` to Saved Messages.
- Proxy-required connection path.

No live Telegram tests run in normal CI.

### Rollout

1. Add provider, actions, credential schema, setup metadata, and fake-engine tests.
2. Add raw credential passing support in the Worker action execution path.
3. Add `telegram_user_pending_logins` migration and Worker login routes.
4. Add custom connect UI for the Telegram user login wizard.
5. Add mtcute Worker compatibility spike for bundling, WASM initialization, session import/export, and direct development transport.
6. Add SOCKS5 proxy transport and require it for production.
7. Ship with the plugin disabled by default until a real test account passes the live integration suite.
8. Enable for internal/admin users first.

### Open Questions

- Should `telegram_user` credentials use existing `api_key` credential type or add a new `session` type for clarity?
- If connection setup latency is high, should the first optimization be a per-user Durable Object session cache or a narrower action batching API?
- Should the session generator support QR login later, or keep phone-code login as the only first-party setup flow?

## References

- Cloudflare Workers TCP sockets: `https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/`
- Cloudflare Workers limits: `https://developers.cloudflare.com/workers/platform/limits/`
- Telegram MTProto 2.0: `https://core.telegram.org/mtproto`
- Telegram MTProto transports: `https://core.telegram.org/mtproto/mtproto-transports`
- Telegram API ID/hash setup: `https://core.telegram.org/api/obtaining_api_id`
- Telegram authorization method shape: `https://core.telegram.org/method/auth.sendCode`
- mtcute repository: `https://github.com/mtcute/mtcute`
- mtcute storage and session strings: `https://mtcute.dev/guide/topics/storage.html`
- mtcute transport customization: `https://mtcute.dev/guide/topics/transport.html`
- mtcute manual sign-in: `https://mtcute.dev/guide/intro/sign-in.html`

## Recommendation

Proceed with a Worker-native `telegram_user` plugin using a Valet-controlled session generator, Valet-owned Telegram application credentials, `@mtcute/core`, and plugin-owned Cloudflare Worker adapters. Do not accept user-imported sessions.

The platform changes needed for MVP are generic raw credential passing for native plugins, a custom setup-flow hook for integrations, and the Telegram pending-login routes/table. All Telegram-specific protocol, setup, adapter, and action code should live in `packages/plugin-telegram-user/` where possible.
