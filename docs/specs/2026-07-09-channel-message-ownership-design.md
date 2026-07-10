# Channel Message Ownership Design

## Goal

Prevent one Valet user from updating or deleting an external-channel message
created for another user when the integration uses a shared credential (for
example, the organization-wide Slack bot token).

The authorization decision must be generic across channel integrations and
must not rely on the external platform treating two Valet users as distinct
authors.

## Problem

Slack's `chat.update` and `chat.delete` only establish that the authenticated
bot created a message. Valet currently resolves that bot token at the
organization level, so messages created for different Valet users have the
same external author. Consequently, a caller who knows a message's channel
and timestamp can target another user's Valet-created message.

The existing private-channel check answers a different question: whether the
caller may access the conversation. It does not establish who owns a
particular outbound message.

## Scope

This design covers every Valet-created external message that can be mutated:

- Agent-visible channel actions such as Slack `send_message`,
  `update_message`, and `delete_message`.
- Normal channel replies sent through `ChannelRouter`.
- Interactive approval/question prompts and their resolution updates.
- Future channel transports and message-mutation actions.

The owner is the Valet user in the action or channel context. For a shared
session, that is currently the session's owning user, matching existing action
policy and invocation attribution. Attributing an action to a particular
shared-session participant is a separate feature.

The recorded owner may mutate a message. A Valet user whose current
`users.role` is `admin` may also mutate any managed, live message in the same
organization. The worker evaluates that role at authorization time; plugins
never receive a caller-controlled admin flag.

## Decision

Add one small, purpose-built D1 table: `channel_message_refs`.

It is an authorization index, not a second activity log. It contains no
message content and does not duplicate action parameters or results. It keeps
the exact external identifier, its Valet owner, and optional provenance links.

The Worker owns all persistence and authorization. Plugins receive a typed
capability, not `AppDb`, D1, or an untyped `ctx as any` escape hatch.

## Why Existing Records Are Not the Authority

### `action_invocations`

`action_invocations` records the actor and opaque `params`/`result` JSON, but
it is not a message index:

- Its request parameters are caller-supplied before the external API call, so
  they cannot prove a message was created by that caller.
- Action-result shapes are plugin-specific and unindexed. A generic lookup
  cannot safely infer which JSON field is an externally-created message.
- It only covers action executions. Channel replies and interactive prompts do
  not create action invocations.
- Current allow-mode session invocations are created as `executed` before the
  API call; the later execution marker only writes results for `pending` or
  `approved` rows. Existing result JSON therefore cannot be backfilled or
  trusted as a complete source of sent-message metadata.

An invocation ID is still useful as optional provenance on the new row.

### `channel_thread_mappings` and `channel_bindings`

These are routing records. They identify an external conversation/thread, not
each outbound message, and can be replaced or removed when a session or
binding changes. Reusing them would conflate routing lifecycle with security
authorization.

### Session messages and analytics events

The `messages` table stores Valet conversation transcript state and does not
store the external message identifier. Analytics events are delayed telemetry
and may be pruned. Neither is safe for request-time authorization.

## Data Model

```sql
CREATE TABLE channel_message_refs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  channel_type TEXT NOT NULL,
  connection_scope TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  action_invocation_id TEXT REFERENCES action_invocations(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);

CREATE UNIQUE INDEX idx_channel_message_refs_external
  ON channel_message_refs (
    org_id, channel_type, connection_scope, channel_id, message_id
  );

CREATE INDEX idx_channel_message_refs_owner
  ON channel_message_refs (owner_user_id, created_at);
```

`connection_scope` is an opaque, Worker-derived identifier for the external
credential namespace. It prevents collisions where the same channel and
message IDs exist in different connected accounts. Plugins never supply or
choose this value.

The Worker must resolve a typed channel connection alongside every channel
token. That connection has a stable `connectionScope` independent of the raw
secret and is threaded into the ownership capability when the context is
created. For the current Slack org installation it is the installed Slack team
ID. For a user-scoped channel it is the stable credential/configuration record
ID; a future provider may instead supply a stable external account or bot ID.
Two separately configured connections may intentionally have distinct scopes
even if they happen to use the same external credential: that can only deny a
cross-connection mutation, never grant one.

`deleted_at` preserves an authorization/audit tombstone after a successful
external deletion. A tombstoned row cannot be updated or deleted again.

If the owner is deleted, the foreign key is set to `NULL`. Members cannot
mutate that ref, but a current admin may mutate its live managed ref under the
same override used for unattributed system messages. Session and
action-invocation references are provenance only and may be nulled
independently without changing the message's external identity.

## SDK Contract

Add a typed worker-owned capability to the SDK action and channel contexts.
The API accepts only platform-level identity supplied by the plugin; the
Worker fills in the actor, organization, and connection scope.

```ts
interface ChannelMessageRefInput {
  channelType: string;
  channelId: string;
  messageId: string;
}

interface ChannelMessageOwnership {
  registerCreated(ref: ChannelMessageRefInput): Promise<void>;
  assertCanModify(ref: ChannelMessageRefInput): Promise<void>;
  markDeleted(ref: ChannelMessageRefInput): Promise<void>;
}
```

`ActionContext` and `ChannelContext` expose this capability. The worker
creates it from the resolved channel connection for every execution path,
including normal session tools, workflow tools, channel replies, and
interactive prompts. A missing capability is an internal configuration error,
never a reason to skip the check.

The capability is bound to an effective owner before the plugin runs:

- Session tools use the session's owning user.
- Workflow tools use the workflow invocation's `userId`.
- A channel reply or webhook response uses the target session/binding owner.
- Interactive-prompt updates use the prompt's owning session user, not the
  person who clicked a button; the responder is display/audit metadata only.
- A truly unattributed system send is recorded with `owner_user_id = NULL`.
  It cannot be mutated by a member, but a current organization admin may
  mutate it through the same centralized authorization check.

The capability returns stable authorization errors:

- `message_not_managed` for an unknown or legacy reference;
- `message_not_owned` for an existing message owned by another user;
- `message_deleted` for a tombstoned reference.

For an exact external identity, the Worker first determines whether the actor
is the recorded owner or has the current `admin` role. A member who is neither
receives `message_not_owned` whether or not the message was deleted; this
avoids revealing lifecycle state to another user. The owner or an admin
receives `message_deleted` for a tombstoned row. An admin cannot revive or
modify an unknown/legacy ref.

Plugins map those errors to concise user-facing messages but must not call the
external mutation API after an authorization error.

## Write and Mutation Flow

### Creating a message

1. The plugin or channel transport sends the message to the external API.
2. It receives the canonical external channel and message IDs.
3. It calls `registerCreated` immediately with those IDs.
4. The worker performs an idempotent insert keyed by the complete external
   identity. It must never overwrite an existing row's owner. A conflicting
   owner is treated as an internal security error.
5. The ordinary action result or channel result is returned.

For action tools, the ownership capability closes over the action invocation
ID so the row records provenance without relying on action-result JSON.

If the platform accepts a send but registration fails, the Worker reports a
delivery-uncertain failure and logs it for reconciliation. It must not claim
that the message is mutable later. This is fail-closed: the externally posted
message remains visible, but no Valet caller can update or delete it until a
trusted reconciliation process records it.

### Updating a message

1. The mutation action parses the external channel/message identifier.
2. The plugin calls `assertCanModify` before the platform API request.
3. The worker does an exact lookup on the unique external identity and requires
   a live row whose `owner_user_id` equals the context user or whose context
   user currently has `users.role = 'admin'`.
4. Only then does the plugin call the external update API.

Private-channel membership checks remain in place. They are complementary:
membership controls channel access; message ownership controls mutation.

### Deleting a message

1. The plugin calls `assertCanModify` before the external delete API request.
2. After the platform confirms deletion, it calls `markDeleted`.
3. The worker sets `deleted_at`; it does not delete the ownership row.

If the external API rejects a deletion, the row stays live. If the external
delete succeeds but marking the tombstone fails, the worker logs the
inconsistency and returns a delivery-uncertain result; a retry will still be
safe because the platform will reject deletion of the already-removed message.

## Channel Transport Integration

`ChannelRouter` becomes the common wrapper for transport sends and mutations:

- After a successful `sendMessage`, it registers the returned `messageId`.
- After a successful `sendInteractivePrompt`, it registers the prompt ref.
- Before calling optional `editMessage`, `deleteMessage`, or
  `updateInteractivePrompt`, it authorizes the reference.

Current route-level direct calls to `transport.sendMessage` must move behind
the same worker helper. This prevents webhook/system replies from becoming
untracked exceptions.

The router retains responsibility for target parsing and token resolution;
the registry does not contain platform-specific Slack or Telegram parsing.

## Action Plugin Integration

Native action plugins that create externally mutable messages call
`registerCreated` only after receiving a successful API response. Mutation
actions call `assertCanModify` before the provider request and `markDeleted`
after a successful delete.

The first concrete adoption is the Slack action source:

- `slack.send_message`, `dm_owner`, and `dm_user` register their Slack
  `{ channel, ts }` response.
- `slack.update_message` authorizes `{ channel, ts }` before `chat.update`.
- `slack.delete_message` authorizes before `chat.delete` and tombstones after
  success.

MCP-proxied actions do not automatically gain message ownership: their result
schemas are provider-defined. A future MCP action can opt in only by using an
explicit trusted message-reference contract. The Worker must never scrape an
arbitrary MCP result or action parameters for identifiers.

## Rollout and Compatibility

There is no safe historical backfill because older activity rows do not
reliably contain canonical, scoped created-message references. The migration
therefore starts tracking new messages at deployment time.

Unknown messages fail closed. That includes legacy Slack action messages and
pre-deployment prompt refs: a user may not update or delete them through the
new generic path. This favors isolation over a temporary cross-user mutation
exception.

The rollout updates all currently supported channel send paths in the same
release, then enables Slack update/delete enforcement. Do not ship the checks
before the new-message registration paths are active.

## Testing

Tests must demonstrate these properties:

1. A successful send creates exactly one ref with the calling user's owner ID
   and the worker-derived connection scope.
2. A second registration for the same external identity is idempotent for the
   same owner and cannot transfer ownership to another user.
3. Update and delete reject an unknown, legacy, tombstoned, or other-user ref
   before invoking the platform client.
4. The owner can update and delete their own live ref; successful deletion
   creates a tombstone.
5. Private-channel membership denial still prevents a Slack mutation even when
   the caller owns the ref.
6. The same action behavior works through normal session execution and
   workflow execution.
7. Channel replies and interactive prompts are registered, and their internal
   update paths authorize the recorded owner.
8. A storage failure after an external send returns the delivery-uncertain
   failure and leaves no authorization bypass.
9. Identical platform channel/message IDs under different resolved connection
   scopes cannot authorize each other.
10. An admin can update/delete another user's managed live ref, while a member
    cannot; neither can mutate an unknown or tombstoned ref.
11. An admin can mutate a managed live ref whose owner was deleted; a member
    cannot.

## Non-Goals

- Retroactively granting mutability to untracked messages.
- Storing external message bodies or attachments.
- Inferring message ownership from untrusted action parameters, arbitrary JSON
  result fields, analytics events, or routing mappings.
