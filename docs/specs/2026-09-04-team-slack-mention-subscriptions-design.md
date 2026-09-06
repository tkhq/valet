# Team Slack mention subscriptions

**Date:** 2026-09-04
**Status:** Accepted (decision 3)
**Tickets:** [TKAI-304](https://linear.app/turnkey/issue/TKAI-304), [TKAI-364](https://linear.app/turnkey/issue/TKAI-364)
**Relates to:** TKAI-299 (`packages/api/src/events/mention-scope.ts`), `docs/specs/2026-07-20-event-system-design.md`, `docs/specs/2026-08-17-team-workspace-ui-design.md`

This PR ships **decision 3**: a team-owned mention subscription stays creator-scoped. Only the member who armed the rule wakes the team assistant. Member B's `@mention` does not match member A's team subscription. TKAI-364's repro is current design, not a bug.

## What already works on `dev-v2`

Channel `@mentions` of the bot already reach Valet. This is not a new Slack ingress. Conner's work (PR #443, #476 / TKAI-299, #448, #538) is the contract this ticket must extend, not replace.

1. Slack delivers `app_mention`. `SLACK_BOT_EVENTS` includes it (`packages/api/src/services/slack-app.ts`). The bot needs `app_mentions:read` and a current app install.

2. `ChannelHost` stays the DM surface. `SlackTransport.parseUpdate` returns null for `app_mention` and for any non-IM message. Channel traffic is the event pipeline's.

3. `fanOutUpdate` (`packages/api/src/routes/slack-webhook.ts`) sends a verified `app_mention` to `ingestEvent` through the `slack.app_mention` trigger (`packages/plugin-slack/src/triggers.ts`).

4. **Creator scope (TKAI-299).** `enforceMentionScope` injects a `user` filter equal to the subscription creator's linked Slack id. A mention subscription without a Slack identity link is refused. The matcher fails closed if that user filter is missing. UI copy: "This rule fires only when you @-mention the app."

5. **Channel scope.** The same gate requires a channel filter, or an explicit `anyChannel` flag. A mention subscription cannot also select another event key.

6. **Who owns the Valet conversation.** Delivery goes to the subscription owner's assistant (`sub.ownerType` / `sub.ownerId`), optionally `target.assistantId`. The Slack thread key is `slack:{channelId}:{thread_ts || ts}`. With `target.follow`, `followed_threads` binds that Slack thread to the same owner. Later messages in the thread, with no new `@mention`, go through `follow-router.ts`. `actorUserId` on both the first delivery and the follow path is `createdBy` (the person who armed the rule / started that Slack chat), not the Slack sender of a later reply.

So today: `@mention` Valet, and that Slack thread belongs to the original creator of the chat with Valet. A teammate who `@mentions` the bot in a new thread does not join the first person's conversation. A teammate who replies in the first person's followed thread is overheard, but the actor stays the original creator.

A team-owned subscription can already be created. The dispatcher already forwards `{ type: "team", id }` to `ensureDefaultAssistantSession`. The mention-scope gate still injects the **creator's** Slack user id. Member B's `@mention` therefore does not match member A's team subscription.

## Decisions

1. **Do not change the personal contract.** Personal mention subscriptions stay creator-scoped. DMs stay on `ChannelHost`. `channel_bindings` stay out.

2. **Team subscriptions keep the same Slack thread model.** One Slack thread maps to one Valet conversation, owned by the subscription owner (the team). Follow still binds `followed_threads` to that owner. Later replies in that thread stay on that conversation. The original creator of the Slack chat remains `createdBy` on the follow row.

3. **Chosen: keep creator scope on team subscriptions too.** Only the member who armed the team rule wakes the team assistant with an `@mention`. That matches how personal rules work and how followed threads already attribute the actor. The wizard hint says the assistant answers when **you** @-mention the app. The reply step says mentions by other people do not reach that team's assistant.

4. **Not this cut: any-member wake.** At match time, for `ownerType === "team"`, drop the creator `user` filter and require `identityForExternal` plus `isTeamMember`. Unlinked or non-member: no delivery, drop-log `unlinked_sender` or `not_team_member`. Re-check membership at match time. `actorUserId` on the first delivery becomes the linked mentioner. Follow `createdBy` stays the person who started that Slack thread, so a later reply does not rebind the chat to a new owner.

5. **Orchestrator targets only.** Workflow `slack.app_mention` triggers already have their own channel and creator scope (`workflow-triggers.test.ts`). This ticket does not change them.

6. **Who may create does not change.** Any team member may create or disable a team subscription.

7. **Show the team radio.** It already shipped. Decision 3 only needed the copy to match creator-only wake.

## Out of scope

- Re-implementing `app_mention` ingest, mention-scope, or followed threads.
- Making a channel `@mention` open a DM-style `ChannelHost` session.
- Changing who owns an already-followed Slack thread when a second member speaks.
- Decision 4 (`team-slack-gate.ts` and any-member wake).

## Implementation (decision 3)

1. Update automation-wizard copy for a team target: the team's assistant answers when **you** @-mention the bot. Mentions by other people do not reach that team's assistant.
2. Add a route test: team-owned `slack.app_mention` still receives the creator `user` filter from `enforceMentionScope`.
3. TKAI-364: after TKAI-337, have member B `@mention` the bot. Expect no team delivery. That is current behavior.

## Done when

The team radio copy matches creator-only wake, and a team-owned mention subscription still stores the creator `user` filter.
