# Channel Message Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce Valet-side ownership for external channel-message mutations, with an organization-admin override, so a shared bot credential cannot let one user edit or delete another user's message.

**Architecture:** Store every Valet-created external message in a compact D1 authorization index keyed by organization, channel type, connection scope, conversation, and message ID. The Worker injects a typed ownership capability into action and channel contexts; plugins use it before mutation, while the Worker owns persistence, connection scoping, user-role checks, and tombstones.

**Tech Stack:** TypeScript, Cloudflare D1/Drizzle, Hono/Workers, Vitest, Zod, Slack Web API.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/worker/migrations/0027_channel_message_refs.sql` | Add the durable, indexed external-message authorization table. |
| `packages/worker/src/lib/schema/channel-message-refs.ts` | Drizzle schema for the table and indexes. |
| `packages/worker/src/lib/db/channel-message-refs.ts` | Exact-key lookup, immutable registration, authorization, and tombstoning helpers. |
| `packages/worker/src/services/channel-message-ownership.ts` | Worker-owned capability factory and connection-scope resolution. |
| `packages/sdk/src/integrations/index.ts` | Typed action-side ownership capability. |
| `packages/sdk/src/channels/index.ts` | Typed channel-side ownership capability and context field. |
| `packages/worker/src/services/session-tools.ts` | Inject ownership context into normal session action execution, including retries. |
| `packages/worker/src/workflows/nodes/tool.ts` | Inject identical ownership context into workflow action execution and retries. |
| `packages/worker/src/durable-objects/channel-router.ts` | Register outbound replies/prompts and authorize prompt updates. |
| `packages/worker/src/routes/channel-webhooks.ts` and `packages/worker/src/routes/slack-events.ts` | Route direct transport sends through the same registration helper. |
| `packages/plugin-slack/src/actions/actions.ts` | Register Slack action-created messages and authorize update/delete calls. |
| `packages/*/src/**/*.test.ts` | Regression coverage for persistence, authorization, SDK wiring, router behavior, and Slack API non-invocation on denial. |
| `docs/specs/messaging.md` | Promote the new persistent ownership boundary into the messaging source-of-truth spec. |

### Task 1: Add the Message-Reference Authorization Store

**Files:**
- Create: `packages/worker/migrations/0027_channel_message_refs.sql`
- Create: `packages/worker/src/lib/schema/channel-message-refs.ts`
- Create: `packages/worker/src/lib/db/channel-message-refs.ts`
- Create: `packages/worker/src/lib/db/channel-message-refs.test.ts`
- Modify: `packages/worker/src/lib/schema/index.ts`
- Modify: `packages/worker/src/lib/db.ts`

- [ ] **Step 1: Write failing DB-helper tests**

Cover registration, same-owner idempotency, conflicting-owner rejection, member ownership, admin override, owner-deleted/admin behavior, tombstones, and connection-scope isolation.

- [ ] **Step 2: Run the DB-helper test file to verify it fails**

Run: `pnpm test packages/worker/src/lib/db/channel-message-refs.test.ts`

Expected: FAIL because the schema and helpers do not exist.

- [ ] **Step 3: Add the additive migration and Drizzle schema**

Create the table and both indexes from the approved design. Use nullable foreign keys with `ON DELETE SET NULL` for ownership provenance and do not store message content.

- [ ] **Step 4: Implement minimal DB helpers**

Implement exact external-identity registration, lookup, authorization decision, and tombstone writes. Registration must never transfer ownership; authorization must load the actor's current role from `users` and apply owner/admin/tombstone precedence without exposing tombstone state to unauthorized members.

- [ ] **Step 5: Export the new schema and helper module**

Add only the new public Worker exports required by callers.

- [ ] **Step 6: Run the DB-helper test file to verify it passes**

Run: `pnpm test packages/worker/src/lib/db/channel-message-refs.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit the store layer**

```bash
git add packages/worker/migrations/0027_channel_message_refs.sql packages/worker/src/lib/schema/channel-message-refs.ts packages/worker/src/lib/schema/index.ts packages/worker/src/lib/db/channel-message-refs.ts packages/worker/src/lib/db/channel-message-refs.test.ts packages/worker/src/lib/db.ts
git commit -m "feat: store channel message ownership"
```

### Task 2: Define and Inject the Worker-Owned Capability

**Files:**
- Create: `packages/worker/src/services/channel-message-ownership.ts`
- Create: `packages/worker/src/services/channel-message-ownership.test.ts`
- Modify: `packages/sdk/src/integrations/index.ts`
- Modify: `packages/sdk/src/channels/index.ts`
- Modify: `packages/worker/src/services/session-tools.ts`
- Modify: `packages/worker/src/workflows/nodes/tool.ts`
- Modify: `packages/worker/src/services/session-tools.test.ts`
- Modify: `packages/worker/src/workflows/nodes/tool.test.ts`

- [ ] **Step 1: Write failing capability tests**

Test that a capability captures actor, organization, channel type, and Worker-derived connection scope; that it rejects absent/mismatched refs before a plugin API call; and that session and workflow execution both receive it.

- [ ] **Step 2: Run the focused capability tests to verify they fail**

Run: `pnpm test packages/worker/src/services/channel-message-ownership.test.ts packages/worker/src/services/session-tools.test.ts packages/worker/src/workflows/nodes/tool.test.ts`

Expected: FAIL because contexts have no ownership capability.

- [ ] **Step 3: Add typed SDK interfaces**

Add `ChannelMessageRefInput` and a `ChannelMessageOwnership` interface with `registerCreated`, `assertCanModify`, and `markDeleted`. Add optional ownership fields to `ActionContext` and `ChannelContext`; do not expose D1 or `AppDb` to plugins.

- [ ] **Step 4: Implement Worker capability and connection scope resolution**

Resolve Slack scope from the configured Slack install's team ID. Use a stable user/channel-credential scope for other current user-scoped channel transports. Bind user ID, org ID, optional session/invocation provenance, and current-role authorization inside the Worker capability.

- [ ] **Step 5: Inject it into every action execution path**

Create the capability in `executeAction` and both workflow action attempts, including the auth-refresh retry. Remove the current untyped `appDb`/`env` plugin-context escape hatch where the typed capability replaces it.

- [ ] **Step 6: Run the focused capability tests to verify they pass**

Run: `pnpm test packages/worker/src/services/channel-message-ownership.test.ts packages/worker/src/services/session-tools.test.ts packages/worker/src/workflows/nodes/tool.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit the capability layer**

```bash
git add packages/sdk/src/integrations/index.ts packages/sdk/src/channels/index.ts packages/worker/src/services/channel-message-ownership.ts packages/worker/src/services/channel-message-ownership.test.ts packages/worker/src/services/session-tools.ts packages/worker/src/services/session-tools.test.ts packages/worker/src/workflows/nodes/tool.ts packages/worker/src/workflows/nodes/tool.test.ts
git commit -m "feat: inject channel message ownership context"
```

### Task 3: Enforce Slack Action Ownership

**Files:**
- Modify: `packages/plugin-slack/src/actions/actions.ts`
- Modify: `packages/plugin-slack/src/actions/actions.test.ts`

- [ ] **Step 1: Write failing Slack action tests**

Add tests showing each successful send action registers the returned `{ channel, ts }`; update/delete refuse an unknown or other-user ref before `chat.update`/`chat.delete`; the owner and an admin proceed; and delete tombstones only after Slack confirms success. Add a registration-failure case proving that a Slack-successful send returns a logged delivery-uncertain error instead of normal success.

- [ ] **Step 2: Run the Slack action tests to verify they fail**

Run: `pnpm test packages/plugin-slack/src/actions/actions.test.ts`

Expected: FAIL because actions call Slack without the ownership capability.

- [ ] **Step 3: Register successful Slack sends**

Update `openAndSendDM` and `slack.send_message` to call `ctx.channelMessages.registerCreated` only after Slack returns canonical channel and timestamp values. Catch a post-send registration failure, log platform identifiers for reconciliation, and return a deterministic delivery-uncertain action error without claiming the message is managed.

- [ ] **Step 4: Gate Slack mutations**

Keep the private-channel guard, then call `assertCanModify` before `chat.update`/`chat.delete`. Call `markDeleted` only after a successful `chat.delete`. Map capability errors to actionable, non-disclosing action errors.

- [ ] **Step 5: Run the Slack action tests to verify they pass**

Run: `pnpm test packages/plugin-slack/src/actions/actions.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit Slack enforcement**

```bash
git add packages/plugin-slack/src/actions/actions.ts packages/plugin-slack/src/actions/actions.test.ts
git commit -m "fix: enforce Slack message ownership"
```

### Task 4: Cover Channel Router and Direct Channel Sends

**Files:**
- Modify: `packages/worker/src/durable-objects/channel-router.ts`
- Modify: `packages/worker/src/durable-objects/channel-router.test.ts`
- Modify: `packages/worker/src/durable-objects/session-agent.ts`
- Modify: `packages/worker/src/durable-objects/session-agent.test.ts`
- Modify: `packages/worker/src/routes/channel-webhooks.ts`
- Modify: `packages/worker/src/routes/channel-webhooks.test.ts`
- Modify: `packages/worker/src/routes/slack-events.ts`
- Modify: `packages/worker/src/routes/slack-events.test.ts`

- [ ] **Step 1: Write failing router and route tests**

Cover registering `sendMessage` and interactive-prompt refs, authorizing interactive-prompt updates, and ensuring direct webhook/Slack-event transport sends use the same registration path with their effective user or system owner. Include a post-send registration failure: the caller receives a delivery-uncertain error and the message never becomes mutable through the ownership API.

- [ ] **Step 2: Run the router and route tests to verify they fail**

Run: `pnpm test packages/worker/src/durable-objects/channel-router.test.ts packages/worker/src/routes/channel-webhooks.test.ts packages/worker/src/routes/slack-events.test.ts`

Expected: FAIL because successful sends do not persist ownership refs.

- [ ] **Step 3: Add a shared Worker transport-send wrapper**

Have the wrapper build a `ChannelContext` with the typed capability, send through the transport, and register canonical returned IDs. It must support user-owned and unattributed-system sends without allowing a member to mutate a `NULL` owner ref. If registration fails after a provider success, return a logged delivery-uncertain error rather than a normal send success.

- [ ] **Step 4: Route all current direct sends through the wrapper**

Add a `SessionAgentDO` dependency that resolves the Worker-owned connection/capability context from its environment, database, user, and current organization; inject it into `ChannelRouter`. Replace direct `transport.sendMessage` calls in Slack events and channel webhooks with the same Worker helper. Update `ChannelRouter` to use that helper for replies/prompts and authorize prompt-resolution updates before transport mutation.

- [ ] **Step 5: Run the router and route tests to verify they pass**

Run: `pnpm test packages/worker/src/durable-objects/channel-router.test.ts packages/worker/src/routes/channel-webhooks.test.ts packages/worker/src/routes/slack-events.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit channel-path coverage**

```bash
git add packages/worker/src/durable-objects/channel-router.ts packages/worker/src/durable-objects/channel-router.test.ts packages/worker/src/durable-objects/session-agent.ts packages/worker/src/durable-objects/session-agent.test.ts packages/worker/src/routes/channel-webhooks.ts packages/worker/src/routes/channel-webhooks.test.ts packages/worker/src/routes/slack-events.ts packages/worker/src/routes/slack-events.test.ts
git commit -m "feat: track outbound channel message ownership"
```

### Task 5: Document and Verify the Complete Feature

**Files:**
- Modify: `docs/specs/messaging.md`
- Modify: `docs/specs/2026-07-09-channel-message-ownership-design.md` only if implementation reveals a required design correction

- [ ] **Step 1: Update the messaging source-of-truth spec**

Document `channel_message_refs`, the owner/admin mutation rule, and the requirement that all new outbound sends register canonical external identifiers.

- [ ] **Step 2: Regenerate plugin registries and typecheck**

Run: `make generate-registries && pnpm typecheck`

Expected: exit 0.

- [ ] **Step 3: Run targeted regression tests**

Run: `pnpm test packages/worker/src/lib/db/channel-message-refs.test.ts packages/worker/src/services/channel-message-ownership.test.ts packages/plugin-slack/src/actions/actions.test.ts packages/worker/src/durable-objects/channel-router.test.ts packages/worker/src/routes/channel-webhooks.test.ts packages/worker/src/routes/slack-events.test.ts`

Expected: PASS.

- [ ] **Step 4: Run the full test suite**

Run: `pnpm test`

Expected: PASS.

- [ ] **Step 5: Commit documentation and any final integration adjustments**

```bash
git add docs/specs/messaging.md docs/specs/2026-07-09-channel-message-ownership-design.md
git commit -m "docs: document channel message ownership"
```
