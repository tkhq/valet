# Telegram Channel Design — first v2 channel plugin (Phase 7)

**Date:** 2026-07-15
**Status:** Draft
**Scope:** The v2 `ChannelTransport` contract (engine), the API's channel ingress + routing layer (webhook and long-poll), Telegram identity linking, and the Telegram transport itself: orchestrator-first DMs with text, media, decision-gate inline buttons, and attention-router notifications. Group chats, Slack, and per-user bots are out of scope.

## Context

Everything around the channel seam already exists as reserved shape:

- `ValetPlugin` (`packages/engine/src/valet-plugin.ts:58-68`) has five capability fields and an explicit comment that `transports` lands with Telegram in Phase 7.
- `packages/plugin-telegram` is a stub manifest with `enabled: false` in `plugin.yaml`, waiting for the transport.
- The orchestrator spec (`docs/specs/2026-07-11-orchestrator-engine-design.md`) defines the ingress pipeline the app must fill: `conversationKey → binding → { owner, sessionId, threadKey }`.
- `channelBindings`, `userIdentityLinks`, and `eventDropLog` tables exist in `packages/api/src/schema/index.ts` as shapes with no routing logic (Phase 6 note at `:502-506`).
- The v2 API has **zero** webhook/channel ingress routes today; messages enter only via `POST /api/sessions/:id/messages` → `thread.submitPrompt`.
- Credentials: `CredentialDeclaration` already supports `type: "bot_token"`; the credential store keys on `CredentialOwner` + service.

This pass turns those shapes into the first working channel, and in doing so pins the contract Slack will reuse.

## Decisions (locked)

1. **Orchestrator-first DMs.** A Telegram DM maps to the sender's **user orchestrator session** (`orchestrator:{userId}` identity in engine v2 terms). The orchestrator routes work and relays child sessions; there is no direct chat↔session binding this pass. Thread key: `telegram:{chatId}` on the orchestrator session — one durable thread per DM chat, created on first message via the existing thread-resolution path.

2. **Engine grows the v2 `ChannelTransport` contract (additive).** `ValetPlugin` gains `transports?: ChannelTransportFactory[]`; the structural validator (`validateValetPlugin`) validates it like the other capability arrays. The contract lives next to `TriggerDef` in `valet-plugin.ts` and follows the same verify-before-parse philosophy:
   - `ChannelTransportFactory`: `{ channelType: string; create(ctx: TransportContext): ChannelTransport }` where `TransportContext` carries the resolved `StoredCredential` and a config record — the factory never reads env vars.
   - **Ingress:** `verifyWebhook(headers, rawBody): RawChannelUpdate[] | null` (null = reject; for Telegram this checks the `X-Telegram-Bot-Api-Secret-Token` header against the secret registered at `setWebhook` time) and `poll?(signal: AbortSignal): AsyncIterable<RawChannelUpdate>` (Telegram: `getUpdates` long-poll loop with offset tracking and exponential backoff). Both feed the same normalized path.
   - **Parse:** `parseUpdate(update): InboundChannelEvent | null` → `{ dispatchId, conversationKey, sender: { externalId, displayName }, kind: "message" | "command" | "gate_callback", text?, media?, raw }`. `dispatchId` = `telegram:{update_id}` — the dedup key. `conversationKey` = `telegram:dm:{chatId}` (the codec is transport-owned; the host treats it as opaque).
   - **Outbound:** `send(target, message: OutboundChannelMessage): Promise<SendRef>` (markdown→Telegram-HTML formatting is transport-internal), `sendGatePrompt(target, gate): Promise<GatePromptRef>` (inline keyboard), `updateGatePrompt(ref, resolution)` (edit-on-resolution), `sendMedia(target, attachment)`.
   - The legacy SDK `ChannelTransport` (`packages/sdk/dist/channels/`) is not extended or reused — this is the rewrite the plugin-v2 spec called for. The Telegram Bot API client code is lifted from the legacy transport where it survives contact with the new contract.

3. **Ingress is config-driven: webhook when public, long-poll otherwise.** A new `ChannelHost` service in `packages/api/src/channels/` owns both modes:
   - **Webhook mode** (when a public base URL is available — `VALET_PUBLIC_URL`, falling back to `BETTER_AUTH_URL` when it's a publicly reachable host; long-poll otherwise): route `POST /api/channels/:channelType/webhook`, body verified by `transport.verifyWebhook` **before** parsing. The host calls `setWebhook` with a per-boot random `secret_token` on startup and `deleteWebhook` is never needed on shutdown (Telegram keeps it; re-registering is idempotent).
   - **Long-poll mode** (default; works on local k3s and `make dev-local` with no tunnel): the host runs `transport.poll()` per configured bot token, with the poller's offset persisted in memory only (Telegram redelivers unacked updates on restart; dedup absorbs replays).
   - Both funnel into one `handleUpdate(channelType, event)` path. Mode is chosen at boot per transport; flipping requires a restart.

4. **Dedup + drop accounting.** `handleUpdate` dedups on `dispatchId` (persisted; reuses the dispatch-dedup mechanics the signal path already has — unique-violation catch, not read-then-write). Every update that cannot be routed writes an `eventDropLog` row with a reason (`unlinked_sender`, `duplicate`, `verify_failed`, `unsupported_kind`) — this finally gives the drop log its routing-specific reasons.

5. **Identity linking: one-time code from web settings.** New settings surface "Connected accounts → Telegram":
   - `POST /api/me/identity-links/telegram/start` mints a single-use, 10-minute code (random, hash stored) and returns the deep link `https://t.me/<bot_username>?start=<code>`.
   - The transport surfaces `/start <code>` as `kind: "command"`; the host verifies the code and writes a `userIdentityLinks` row (`channelType: "telegram"`, `externalId`: Telegram numeric user id → Valet user id). Re-linking replaces the row; unlink is a settings action (`DELETE`).
   - Messages from unlinked senders get one polite "link your account at …" reply per chat per hour (rate-limited in memory) plus a drop-log row.

6. **Routing: identity link → orchestrator, no binding rows this pass.** For a DM: resolve sender via `userIdentityLinks` → that user's orchestrator session → thread key `telegram:{chatId}` → `thread.submitPrompt(text, …)` as a **user prompt** (human messages are prompts, not signals — signals remain agent-to-agent per the orchestrator spec). The `channelBindings` table stays shape-only; it's the seam for explicit chat↔session binds (groups, Slack channels) in a later pass, and this spec doesn't touch it.

7. **Outbound replies: engine event subscription per telegram thread.** The `ChannelHost` subscribes to the engine's session event stream for orchestrator sessions and, for threads whose key starts with `telegram:`, delivers completed assistant messages via `transport.send` (chatId decoded from the thread key). Delivery is at-least-once with a per-thread high-water mark held in memory; on api restart the host does not re-deliver history (high-water mark initializes to "now"). Streaming deltas are not sent — Telegram gets whole messages (optionally a `sendChatAction: typing` indicator while a turn runs).

8. **Decision gates over Telegram.** When a decision gate opens on a telegram-keyed thread (or targets the user via the attention router), the host calls `sendGatePrompt` → inline keyboard (one button per option). `callback_query` arrives as `kind: "gate_callback"` carrying `{gateId, optionId}`; the host resolves the gate through the existing gate-resolution path (same code as `POST /decisions/:gateId/resolve`, session-access enforced against the linked user) and `updateGatePrompt` edits the message to show the outcome. Gates resolved elsewhere (web) also edit the Telegram message — the gate-resolution path fans out to the host.

9. **Attention-router delivery adapter.** The attention router (wired in `main.ts`) gains a Telegram delivery target: when the addressed user has a Telegram identity link, attention items (child settled, needs input, task done) are delivered to their DM chat — including for sessions started on the web. Per-user notification preference (on/off) lives with the identity link row; default on.

10. **Media, both directions.**
    - **Inbound:** photos/documents/voice up to 20 MB (Bot API `getFile` limit) are downloaded via the Bot API and admitted as attachment parts on the prompt; the prompt text carries the caption. Today `submitPrompt` takes text only — if prompt admission lacks attachment parts, this pass adds them to the engine as an additive change (review-flagged like every shared-contract touch); fallback if that grows too large: persist the file via the api and admit a prompt referencing its download URL. Oversize or unsupported media degrades to a text prompt noting the skipped attachment.
    - **Outbound:** assistant message parts carrying image/file attachments map to `sendPhoto`/`sendDocument`; text parts to `send`.

11. **Credentials: one org-level bot.** The Telegram manifest declares `credentials: [{ type: "bot_token", configKeys: ["accessToken"], connectLabel: "Connect Telegram bot" }]`; an org admin pastes the BotFather token in the integrations settings (the existing credential-store surface). Stored as an org-owned `StoredCredential` under service `telegram`. No bot token → transport not started; the settings surface says so. Per-user bots are a non-goal.

12. **Plugin activation mechanics.** Flip `packages/plugin-telegram/plugin.yaml` (drop `enabled: false`), give `package.json` the `./plugin` export + `valet.plugin` marker, implement `src/plugin.ts` (manifest with `transports` + the credential declaration) and `src/transport/` (Bot API client + transport), rerun `make generate-registries`.

## Exit criteria (the dogfood)

Against a real BotFather bot on local dev (long-poll mode, no tunnel): link an account from web settings via the deep link; DM the bot and get an orchestrator reply in the same chat; send a photo with a caption and see the orchestrator reference it; trigger a decision gate from a Telegram-initiated task and resolve it via inline button (message edits to show the outcome); start a session on the **web** that ends in an attention ping and receive it in Telegram; message from a second, unlinked Telegram account and get the link-your-account reply plus a drop-log row; restart the api and confirm no duplicate deliveries and the poller resumes.

## Testing

- **Transport unit tests** against a local fake Bot API server (Hono fixture): webhook verify accept/reject, `getUpdates` offset/backoff behavior, parse of message/command/callback/media updates, markdown formatting edge cases, gate keyboard construction + edit.
- **Ingress/routing integration** (real engine, in-memory/PGlite store, fake Bot API): linked sender → orchestrator prompt admitted on `telegram:{chatId}` thread; unlinked → drop log + rate-limited reply; duplicate `update_id` admitted once; gate round-trip callback → resolved + message edited; api restart → poller resumes without redelivery.
- **Contract:** `validateValetPlugin` accepts/rejects `transports` shapes; registry generation picks up the flipped plugin.
- **Live e2e** gated on `TELEGRAM_TEST_BOT_TOKEN`: link → DM → reply round trip.

## Non-goals

- Group chats, mention-gating, org-orchestrator routing of unattributed senders (Slack-era pass; `channelBindings` is the reserved seam).
- Slack or any second transport (this pass pins the contract; Slack validates it later).
- Per-user bot tokens; multiple bots per org.
- Streaming/edited-message mirroring of in-progress turns (whole messages only).
- Webhook mode ergonomics beyond `VALET_PUBLIC_URL` (no tunnel automation).
- Telegram-side slash-command UX (`setMyCommands`) beyond `/start` — later polish.
