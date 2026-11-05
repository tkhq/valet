# Slack conversation routing implementation plan

Goal: keep Home and separate new Slack DM conversations without losing old chats.

Architecture: the API resolves each direct Slack conversation through an
immutable database binding. It recovers old native or Home destinations from
stored provenance. The engine graph and mobile navigation stay unchanged.

Spec: `docs/specs/2026-10-23-slack-conversation-routing-design.md`.

## Constraints and review focus

- Scope every binding by organization, user, assistant session, and full external key.
- Preserve old Home questions, queued inputs, command results, edits, and links.
- Concurrent first messages and delivery retries must use the same destination.
- Unknown edits must not create chats or call the model.
- Missing bound destinations must fail without rerouting.
- Keep desktop Home, phone navigation, and ordinary Slack chat rows accessible.
- Stage explicit paths. Sign commits with a Changelog trailer. Do not merge upstream.

## Task 1: Durable bindings

Files: `channels/conversation-bindings.ts`, its tests, app schema, 0000 app
migration, and additive schema repairs.

- [x] Add failing persistence, scope, concurrency, provenance, and repair tests.
- [x] Implement `findConversationBinding`, `bindConversation`, and
  `hasLegacyHomeConversation` with typed, bounded database operations.
- [x] Run binding and schema tests with at most three workers.

## Task 2: Route messages and edits

Files: `channels/host.ts`, `channels/host.test.ts`, Home context and specs.
Consumes Task 1's immutable thread identifier and legacy provenance lookup.

- [x] Assert new roots get native chats and old Home roots stay in Home.
- [x] Assert repeated edits, questions, approvals, and retries keep their origin.
- [x] Watch the new regression tests fail before changing routing.
- [x] Resolve the binding before admitting messages or recording edit notes.
- [x] Run host and channel suites. Check restart and concurrent delivery cases.

## Task 3: Validate and pilot

Files: existing Home/sidebar tests and spec validation records.

- [x] Retain desktop Home and mobile flow tests; check both widths locally.
- [ ] Run root typecheck, web typecheck/build, and the full end to end scorecard.
- [x] Request an independent review and fix material findings with regressions.
- [ ] Sign and push the change. Open a draft PR stacked on desktop Home.
- [ ] Read the live pilot SHA, merge onto it, back up, deploy, and check readiness.
- [ ] Sync the pilot repository with a signed tree-equal merge and record test steps.
