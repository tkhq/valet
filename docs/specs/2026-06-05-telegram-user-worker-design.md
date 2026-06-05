# Telegram User Worker Integration

**Status:** Draft
**Author:** Conner Swann
**Date:** 2026-06-05

## Summary

Add a separate `telegram_user` integration that exposes Telegram user-account actions from the Cloudflare Worker. This integration is distinct from the existing `telegram` bot channel plugin. Users connect it by pasting a reusable Telegram MTProto session string plus their Telegram API ID and API hash; Valet does not implement phone-code or 2FA login in the MVP.

All action execution must run inside the Worker. There is no Python service, Node sidecar, Modal process, hosted MCP server, or sandbox dependency. The plugin can use a Worker-compatible MTProto library if one proves reliable, but the design does not depend on GramJS specifically. If no library fits the Worker runtime, the plugin owns a minimal MTProto implementation for the action surface Valet needs.

## Goals

- Add a first-party action plugin for Telegram user accounts with service id `telegram_user`.
- Keep the existing Telegram bot channel integration unchanged.
- Execute all Telegram account actions inside the Cloudflare Worker.
- Use pasted session strings for MVP setup; avoid Telegram login handshake, phone-code, QR, and 2FA flows.
- Keep protocol, action, schema, and Telegram-specific credential handling self-contained in `packages/plugin-telegram-user/` where possible.
- Support stable egress through a configured external proxy when required.
- Start with a small, policy-friendly tool set: read chats/messages, search messages, send/reply, and mark read.

## Non-Goals

- Replacing the existing `telegram` channel plugin.
- Implementing interactive Telegram login in MVP.
- Running any Telegram code in Valet sandboxes.
- Hosting a separate MCP or Node service for Telegram.
- Full Telethon parity in the first version.
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
  api_id: string;
  api_hash: string;
  session_string: string;
}
```

### Worker Runtime Constraints

Cloudflare Workers support outbound TCP sockets through `connect()` from `cloudflare:sockets`. Sockets must be created inside a handler such as `fetch()`, `scheduled()`, `queue()`, or an alarm; they cannot be created in global scope and shared across requests. Open TCP sockets count toward Worker connection limits.

Cloudflare documentation also states that outbound TCP socket connections are sourced from a prefix that is not part of Cloudflare's published IP ranges. Therefore, if Telegram sessions need stable egress identity, the Worker must connect to an external proxy with stable egress rather than connecting directly to Telegram from arbitrary Worker egress.

Telegram's MTProto transport documentation defines multiple transports, including TCP, WebSocket, HTTP, and HTTPS. This design should prefer the simplest reliable Worker-compatible transport and hide that choice behind a plugin-owned engine interface.

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
  src/actions/engine/library-engine.ts
  src/actions/engine/native-mtproto-engine.ts
  src/actions/engine/transport.ts
  src/actions/engine/session.ts
  src/actions/engine/tl.ts
  src/actions/engine/crypto.ts
```

`plugin.yaml`:

```yaml
name: telegram-user
version: 0.0.1
description: Telegram user account actions over MTProto
icon: "TG"
```

The package exports `./actions` and is registered like other action plugins by `make generate-registries`.

### Service Identity

Use service id `telegram_user`.

Rationale:

- Avoids collision with the existing `telegram` Bot API channel service.
- Makes action policy, credential rows, integration rows, audit logs, and disabled-action state unambiguous.
- Lets a user connect both "Telegram Bot" and "Telegram User Account" at the same time.

### Provider

The provider is a native API-key-style integration, not OAuth and not MCP.

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

- `api_id` exists and parses as a positive integer.
- `api_hash` is a non-empty string.
- `session_string` is a non-empty string.
- Optional proxy config has a supported type and valid public hostname/port.

`testConnection()` creates an engine session and calls `get_me`. It must redact credentials from all errors.

### Credential Schema

MVP credentials:

```ts
export interface TelegramUserCredentials {
  api_id: string;
  api_hash: string;
  session_string: string;
}
```

Optional per-user proxy override:

```ts
export interface TelegramProxyConfig {
  type: 'socks5' | 'mtproxy';
  host: string;
  port: string;
  username?: string;
  password?: string;
  secret?: string;
}
```

Recommended MVP proxy source:

- Prefer org/environment-level proxy config for all Telegram user traffic:
  - `TELEGRAM_USER_PROXY_TYPE`
  - `TELEGRAM_USER_PROXY_HOST`
  - `TELEGRAM_USER_PROXY_PORT`
  - `TELEGRAM_USER_PROXY_USERNAME`
  - `TELEGRAM_USER_PROXY_PASSWORD`
  - `TELEGRAM_USER_PROXY_SECRET`
- Support per-user proxy fields later only if there is a real customer need.

Per-user proxy credentials create extra setup and support burden. A single managed proxy is simpler and matches the "all workers through one external proxy" operating model.

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

The current token dialog only collects one secret string. Add generic multi-field credential form support driven by provider metadata.

SDK addition:

```ts
export interface CredentialFieldDefinition {
  key: string;
  label: string;
  type: 'text' | 'password' | 'number';
  required: boolean;
  placeholder?: string;
  helpText?: string;
}

export interface IntegrationProvider {
  // existing fields...
  readonly credentialFields?: CredentialFieldDefinition[];
}
```

`telegram_user` declares:

```ts
credentialFields: [
  { key: 'api_id', label: 'API ID', type: 'number', required: true },
  { key: 'api_hash', label: 'API Hash', type: 'password', required: true },
  { key: 'session_string', label: 'Session String', type: 'password', required: true },
]
```

No phone-code flow is implemented. The UI help text should tell users to generate a session string outside Valet and paste it here.

### Engine Interface

The actions depend only on a local engine interface.

```ts
export interface TelegramEngine {
  withSession<T>(
    credentials: TelegramUserCredentials,
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
```

Engine selection:

```ts
export function createTelegramEngine(): TelegramEngine {
  if (isWorkerCompatibleLibraryEnabled()) return new LibraryTelegramEngine();
  return new NativeMtprotoEngine();
}
```

The library engine is allowed only if it runs inside Cloudflare Workers without Node-only socket, crypto, filesystem, or Buffer assumptions that cannot be polyfilled safely. The native engine remains the fallback and is the architectural owner of behavior.

### Transport Strategy

Preferred order:

1. Library transport if a dependency works in Workers and supports the required proxy path.
2. Native TCP transport using `cloudflare:sockets`.
3. Native HTTPS/HTTP MTProto transport only if it proves simpler and reliable for the required API calls.

For stable egress, the Worker should connect to the managed proxy hostname. The proxy then connects to Telegram. The plugin must fail closed if proxy env vars are configured but invalid; it must not silently bypass the proxy.

Supported proxy MVP:

- SOCKS5 over Worker TCP sockets.

Deferred:

- MTProxy.
- Per-account proxy overrides.
- Proxy rotation.
- Regional DC pinning.

### Native MTProto Scope

If a manual implementation is required, implement only the protocol pieces needed by the MVP actions.

Core responsibilities:

- Session string parsing and serialization for the chosen session format.
- DC selection and migration handling.
- TCP/proxy transport framing.
- MTProto 2.0 encrypted request/response handling.
- Message id generation and server time offset correction.
- Sequence number and salt handling.
- Basic acks and result dispatch.
- TL serialization/deserialization for the constructors and methods used by the MVP.
- Error normalization for RPC errors, flood waits, auth failures, and DC migration.

Manual engine MVP methods:

- `users.getFullUser` or equivalent account lookup for `get_me`.
- Dialog listing for `list_chats`.
- Entity resolution by id, username, or peer reference.
- Message history retrieval.
- Message search.
- Message send.
- Mark read.

Do not build a generic Telegram TL compiler in the first pass unless it is clearly less work than hand-maintaining the small constructor set. Keep TL coverage explicit and tested.

### Session Lifecycle

Do not cache sockets in global scope.

MVP action flow:

1. Resolve raw encrypted credentials for `telegram_user`.
2. Validate credential shape.
3. Create a fresh engine session.
4. Open a transport connection.
5. Execute one logical action.
6. Close the connection in `finally`.
7. Return normalized JSON.

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
| API ID/hash invalid | Return setup guidance, do not retry. |
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
- Multi-field credential form metadata.
- Raw credential resolver behavior.
- Action definitions and risk levels.
- Parameter validation.
- Error redaction.
- SOCKS5 handshake and proxy failure behavior with fake streams.
- TL serialization/deserialization for every native constructor used.
- Engine action mapping using a fake `TelegramEngine`.

Integration tests behind explicit env flags:

- `get_me` against a test Telegram account.
- `list_chats`.
- `get_messages` from Saved Messages or a test chat.
- `send_message` to Saved Messages.
- Proxy-required connection path.

No live Telegram tests run in normal CI.

### Rollout

1. Add provider, actions, credential schema, and fake-engine tests.
2. Add raw credential passing support in the Worker action execution path.
3. Add multi-field credential UI support.
4. Add a Worker runtime compatibility spike for the preferred library engine.
5. If the library engine fails, implement the native MTProto engine behind the same interface.
6. Ship with the plugin disabled by default until a real test account passes the live integration suite.
7. Enable for internal/admin users first.

### Open Questions

- Which session string format should Valet accept if multiple libraries use incompatible encodings?
- Should Valet publish a small local helper script for users to generate session strings, or only document third-party generation?
- Is a single org-level proxy enough, or do any expected users need per-account proxy configuration?
- Should `telegram_user` credentials use existing `api_key` credential type or add a new `session` type for clarity?
- If connection setup latency is high, should the first optimization be a per-user Durable Object session cache or a narrower action batching API?

## References

- Cloudflare Workers TCP sockets: `https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/`
- Cloudflare Workers limits: `https://developers.cloudflare.com/workers/platform/limits/`
- Telegram MTProto 2.0: `https://core.telegram.org/mtproto`
- Telegram MTProto transports: `https://core.telegram.org/mtproto/mtproto-transports`
- GramJS repository, as one possible implementation reference: `https://github.com/gram-js/gramjs`

## Recommendation

Proceed with a Worker-native `telegram_user` plugin using pasted session strings and a small MVP action set. Design the actions around a `TelegramEngine` interface so implementation can start with a Worker-compatible library if one works, but keep the architecture ready for a native MTProto engine owned by the plugin.

The only platform changes needed for MVP are generic and reusable: raw multi-field credential passing for native plugins and multi-field credential UI metadata. All Telegram-specific protocol and action code should live in `packages/plugin-telegram-user/`.
