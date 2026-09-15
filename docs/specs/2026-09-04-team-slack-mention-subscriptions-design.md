# Team Slack mention subscriptions

**Date:** 2026-09-04
**Status:** Implemented (2026-09-10). Replaces the creator-only interim behavior.
**Tickets:** [TKAI-304](https://linear.app/turnkey/issue/TKAI-304), [TKAI-364](https://linear.app/turnkey/issue/TKAI-364)
**Relates to:** `2026-07-20-event-system-design.md`, `2026-08-28-slack-event-triggers-design.md`, `2026-08-17-team-workspace-ui-design.md`

## Organization bot, team routing

Slack has one organization bot connection. The webhook verifies that connection's signing secret and Slack workspace id before event ingestion.
Team setup creates routing subscriptions for that bot. It does not create a team Slack connection or require a team Slack credential.
Identity links identify people; they are not separate bot connections.

`ChannelHost` remains the DM surface. Channel mentions use the existing `slack.app_mention` event pipeline.
The dispatcher carries the Slack channel and thread origin into the team assistant's signal. Replies use the existing organization bot transport.

## Authorization

1. A team member can create or disable a team subscription. Subscription creation does not require the creator to link Slack.
2. A team assistant mention rule requires named channels or explicit `anyChannel`. It cannot also select other event keys.
3. The matcher removes `user` filters from team assistant mention matching, including creator filters stored by the interim implementation.
4. Before persistence or delivery creation, the matcher resolves the Slack sender with `identityForExternal` and checks the memberships the rule's audience requires.
5. The team must belong to the event's organization. Unlinked senders are denied with an `unlinked_sender` drop log. A denied sender gets `not_team_member` under the team audience and `not_org_member` under the organization audience.
6. Redelivery uses the same live matcher. The dispatcher checks identity and membership again before invoking the assistant.
7. Denied events are not stored unless another authorized subscription matches. Drop logs contain no message body or Slack sender id.

### Invocation audience (2026-09-15)

Ownership and audience are separate. The team owns and administers its assistant. Who may invoke that assistant by mention is a per-subscription choice, stored in the nullable `event_subscriptions.audience` column.

- `team` admits the owning team's current members, checked with `isCurrentTeamActor`. This is the behavior every earlier rule has.
- `organization` admits any current member of the organization that owns the team, checked with `isCurrentOrgActor`. That check keeps the organization-membership join and the team-belongs-to-this-organization condition, and drops only the team-membership join.

A null or absent audience reads as `team`, so no stored rule changes meaning. Only a rule whose target is a team assistant (`kind: "orchestrator"` with `orchestrator: "team"`) may carry an audience. The write gate refuses one on a personal, organization, or workflow target and names the corrective action. Workflow mention triggers stay creator-scoped in this pass, including team-owned workflows.

The decision: a bot invited into a channel answers explicit mentions from any organization member in that channel. The wizard defaults a new team mention rule to the organization audience, and the team-only choice stays one click away.

The audience widens invocation and nothing else. The invocation still runs as the team's assistant with the sender as the actor. It grants the sender no read of the assistant's sessions, no change to its configuration, and no team membership. `canViewSession` still admits only the team's members, and a regression test asserts that an organization member admitted by audience is refused there. What the sender asks for in the channel does run with the team's access and tools, which is the point of inviting the bot into the channel.

Three rules bound that:

1. **Credentials follow the team, never a nonmember actor.** A team session from before the `credential_owner_mode` column is stamped `actor`, and an actor-mode session reads credentials as the prompting member. That holds only while the actor is a current member of the owning team. The credential resolver checks membership live on each read and falls back to the team principal for an actor who is on no team, so a nonmember's personal vault never backs the team's assistant. One related change: an actor-mode session woken by the team's own machine actor (`team:{id}`) now resolves the team's credential row. It previously read as a user with no rows and fell through to the organization fallback.
2. **Workflow tools stay team-member-only.** The `workflows.*` tools keep their `requireTeamMembership` gate on the turn's author, so an organization-audience sender can ask the assistant questions and use its other tools, but cannot run or change the team's workflows. The wizard copy says so.
3. **A followed thread re-checks the audience of the rule that bound it.** `followed_threads` carries the binding rule's id in a nullable column. The follow router reads that rule's CURRENT audience and re-checks organization membership for an organization-audience follow, team membership otherwise, live, on every later message. The audience is the rule's state, not the conversation's: a rule narrowed back to the team narrows every thread it opened, and a rule widened to the organization widens them. A rule that is disabled or deleted resolves to `team`, the narrow reading: turning a rule off is how a person stops it, and it must not leave organization-wide invocation alive in the threads that rule opened. A follow that names no rule reads as `team` for the same reason.

Revocation stops a thread for everyone, not only for the wider audience, because the router checks the membership of the actor the thread is BOUND to. A thread opened by an organization member and then revoked has an actor who is on no team, so an unmentioned reply is dropped whoever sends it. An explicit mention revives it: when the bound rule is disabled or gone, or its actor is no longer authorized, the next mention that passes the gate re-binds the thread to its own actor and rule. A team member mentions the assistant, and the conversation continues under the team audience. A re-mention on a thread that still authorizes its actor changes nothing, which is the existing rule that stops a second member taking a conversation over.

Thread following is on by default in the wizard. A followed thread delivers every later human message in it, from anyone in that thread, with no per-sender check. That is the existing overheard-message contract, and the audience does not change it. What the audience decides is who can OPEN such a thread by mention. The wizard copy says both.

The dead-letter of a denied delivery and the drop-log detail both name the membership the rule's audience requires.

Both memberships are read live at match time and again at delivery time, the same as before. A sender who leaves the organization stops matching on the next mention, cannot replay a stored mention, and cannot wake a queued delivery.

Membership is not cached. A removed member cannot match the next mention, replay a stored mention into the team, or invoke a queued delivery.
A denied queued delivery becomes dead. A new authorized redelivery requires a new match.
Team mention edits remove stored `user` filters. Existing interim subscriptions work without a data migration.
Collision detection uses the same effective filters. Membership sets can change, so team overlap detection is conservative.

## Conversation and actor

The subscription's team owns the assistant. The linked mentioner becomes `actorUserId`, even when another member created the subscription.
The Slack thread key is `slack:{channelId}:{thread_ts || ts}`.

After successful delivery, `target.follow` records the team, selected assistant, and mentioner in `followed_threads`.
The mentioner becomes the follow row's `createdBy`. Team re-mentions do not replace an existing follow binding or rewind its cursor.
Later thread replies use that saved owner, assistant, and actor. They remain overheard messages under the existing follow contract.
They do not change the actor to each later sender. Multiple matching subscriptions can still deliver a mention to multiple assistants.
Only one follow binding can own the Slack thread; collision warnings remain relevant.

The follow router checks the saved actor's current team and organization memberships before reading thread context.
Both memberships must match the team's organization. A stale team membership after organization removal grants no access.
A removed actor cannot wake the team assistant through an existing follow. The router does not rebind the follow to another sender.
Already admitted or running turns are not canceled by this check.

Assistant deliveries persist `actorUserId` in the queue's existing `author` field.
Tools use the running submission's author, with the session user as the fallback for older or authorless submissions.
The cached session user, assistant owner, and credential provider remain unchanged.
Overheard digests preserve their author and merge only messages with the same actor.

Slack sends separate `message` and `app_mention` envelopes for a threaded bot mention.
The follow router skips messages that mention the bot user ID from the verified organization credential.
The `app_mention` path supplies the addressed turn, regardless of envelope order. Existing dispatch IDs still handle retries.
A denied or unmatched bot mention does not fall back to an overheard turn.
Mentions of other bots remain overheard. Explicit workflow subscriptions keep their independent event deliveries.
New validated bot setups require a nonempty `user_id` from Slack's `auth.test` response.
The shared validator rejects missing identity before storing inline or 1Password-backed bot credentials.
The error tells the operator to reinstall the app and reconnect with its Bot User OAuth Token.
This suppression requires the installation's `botUserId` metadata; legacy credentials without it retain the previous follow behavior.

## Preserved behavior

- Personal and organization-owned mention rules remain creator-scoped and require the creator's Slack identity link.
- Workflow mention triggers remain creator-scoped, including team-owned workflows.
- The `workflows.*` tools remain team-member-only, whatever the audience of the rule that started the turn.
- Personal follow rebinding, DMs, non-mention events, and channel bindings keep their existing behavior.
- This change does not add Slack credentials, scopes, installations, or connections.

## Wizard

The reply step offers the active team's assistant and its assistant picker.
A team workspace seeds the team target; create and review keep that target.
Team copy says that linked team members can invoke the assistant. Unlinked senders and nonmembers cannot.
Personal copy keeps the creator-only explanation. Channel scope and follow choices remain explicit.

## Validation

Credential-free tests cover member B invoking member A's rule, legacy filters, denied senders, live removal, channel and organization isolation,
queued dispatch, redelivery, actor attribution, follow preservation, collision detection, and personal/workflow behavior.
Wizard tests cover the enabled team option, member copy, review, submitted target, and existing personal paths.
Webhook tests use an organization bot fixture and a local Slack API mock.

Live Slack installation permissions, actual bot delivery, and provider replies require separate authorized live validation.
No live Slack message is required by these tests.

### Local verification (2026-09-10)

The focused API run passed 209 tests across 11 suites. The wizard passed 21 tests.
The browser check used an isolated local API and `cua_repl`.
It verified required channel and name fields, team selection, review text, creation, and the saved rule after reload.
The saved subscription had team ownership and no creator-user filter.

The user assigned integrated and full e2e verification to main. This worktree's full run was stopped to reduce load.
Live Slack delivery remains unverified. The focused webhook tests mock Slack API responses and use fixture tokens only.

### Review fixes verified (2026-09-11)

Focused API suites passed 66 tests: follow routing, assistant delivery, team mention gating, dispatcher, and Slack webhook.
Engine suites passed 164 tests: happy path, author attribution, commands, overheard digests, queue modes, submissions, and the in-memory store.
Regressions cover removed membership, foreign organizations, saved follow actors, both paired-envelope orders, retries, and unchanged credential ownership.
API and engine typechecks, conventions, and maintained-docs lint passed.
Tests used faux models and mocked Slack responses. No provider messages were sent.
Full e2e remains assigned to main and was not run for these fixes.

### Organization membership and bot identity follow-up (2026-09-11)

The actor query joins `teams`, `team_members`, and `org_members` in one scoped read.
Tests retain stale team rows after organization removal and add membership in another organization.
New mentions, replay matching, queued dispatch, and followed replies all deny that actor.
Credential tests reject missing and empty bot `user_id` without storing a credential.

All 148 tests passed across seven focused API suites, including credentials, dispatcher, delivery, and webhook regressions.
Authorized team fixtures now include organization membership. API typecheck, conventions, and maintained-docs lint passed.
No full e2e or live provider sends ran. The consolidated checkout was not changed.

The full `routes/events.test.ts` run passed 99 tests after its authorized replay fixture gained explicit organization membership.
The replay route regression checks both team removal and organization removal, retaining a stale team row for the latter.
Membership in a different organization does not restore replay access. No broader suites ran for this fixture follow-up.


## Team homepage setup (TKAI-363, 2026-09-11)

The team homepage has a prominent **Set up Slack replies** button. It opens a
modal that reuses the automation wizard's reply and review steps. The team is
fixed to the selected workspace. The reader selects channels and an explicit
team orchestrator; personal targets and the all-channels option stay in Events.
The existing subscription API, membership checks, and collision detection apply.

A missing organization bot links to Organization Settings → Slack. Existing
team reply rules are shown before the reader can add another rule. The shortcut
does not offer collision override; the reader manages conflicts in Events.
Changing teams discards the open draft. Closing returns focus to the homepage
button. The card and dialog fit narrow screens.

Local tests cover member access, missing setup, loading and errors, existing
rules, explicit assistant selection, and the saved channel and team target.
Live acceptance still requires the organization bot: a linked member mentions
Valet in a selected channel, gets one reply from the selected orchestrator, and
continues the same thread. Nonmembers and removed members must not invoke it.
