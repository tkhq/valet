# Thread-first completion

Status, 2026-09-29: remaining product work implemented and reviewed. Functional checks pass after repairs; the full scorecard is not clean because of the infrastructure failures below.

## Contract

Threads are the public conversation address. Runtime IDs remain execution and sandbox boundaries. Existing session API routes and CLI commands stay compatible. Thread routes delegate to existing operations instead of duplicating execution logic.

Thread lookup joins its runtime and restricts by authenticated organization before applying visibility and action authorization. A URL thread cannot be overridden by a body or query field. A decision addressed through a thread must belong to that thread. Team keys retain the restrictions of the compatible session operation.

Workspace lists and creation use the existing personal or team runtime. New workflows get their own conversation; reopening a workflow resumes it. Ask Valet and workflow editing share the assistant panel, transcript, and composer.

## Implemented scope

| Area | Implementation and evidence |
| --- | --- |
| Thread API and CLI | Workspace thread creation/listing, lookup, history, submission, archive, abort/resume, and decisions reuse existing handlers. CLI thread commands and `send`, `chat`, `gates`, `status`, `upload`, and `handoff` accept thread addresses. Legacy runtime commands remain supported. |
| Entry points and terminology | Conversation links use `/threads/:id`, including workflow checkpoints and parent breadcrumbs. User-facing conversation labels say thread. Sandbox, grants, and other runtime-wide operations retain their real scope. Wire identifiers remain compatible. |
| Structured trigger/result review | Assistant proposal tools save paused records. Shared review shows When, Scope, Result, Destination, Permissions, and applicable delivery/audience settings. Existing edit endpoints apply changes and explicit activation together. |
| Subscribe to thread | The existing automation form accepts a Slack thread link and sets exact channel and parent timestamp filters. It does not create an extra follow binding. |
| Routing and authorization | Tests cover fanout, event deduplication, membership changes, org isolation, team keys, sibling decisions, workflow ownership, and personal delivery precedence. |
| Restart and compatibility | On-disk database reopen preserves identity, history, follow bindings, and gate addresses. Engine child-process SIGKILL tests cover pending decisions and queues. Legacy and thread addresses expose compatible history and authority. |
| Archive with a pending approval | Archiving a thread withdraws its pending approvals as cancelled, so the agent does not stay suspended on a hidden thread. A caller who cannot answer the approval gets 409 and is told to have it answered first. |
| Child approvals | A child gate reaches the parent's owner through attention. When a channel message started the work, the gate card also posts in that channel thread, and the callback resolves only the child gate. The parent thread receives one `child.gate_opened` signal per gate, with manual replies, so it knows why the child is paused. Tests cover the originating-thread card, the parent signal and its deduplication, callback restore after host restart, and outsider denial. Approval gates expire after 72 hours. |

Configuration review is separate from human approval checkpoints and reusable action permissions. Workflow grants remain workflow-scoped. Proposals never grant access or enable routing. Repeated proposal keys return the existing record without changing it or creating duplicates.

The acceptance work corrected missing runtime creation for new teams, approval buttons lost after channel-host restart, and duplicate message/follow delivery. It reuses the existing subscription, schedule, and decision-reference storage; no additional schema or execution path was introduced.

## Design and acceptance records

- [Proposal interaction contract](2026-09-29-automation-proposals-design.md)
- [Thread entry points and terminology](2026-09-29-thread-entrypoints.md)
- [Routing acceptance matrix](2026-09-29-routing-acceptance.md)

## Validation

The latest full command was `mise x node@22 -- make e2e E2E_ARGS="--verbose"`.
The latest run ended with **28 stages passed, 0 failed, and 9 skipped**.
The full log is `/tmp/linear-admin-scorecard.log`.
Final Linear security regression tests passed (64 tests), and a forced TypeScript rebuild passed after clean-build narrowing repairs.

| Check | Evidence |
| --- | --- |
| Root test sweep | 817 files passed, 17 skipped; 11,121 tests passed, 65 skipped. |
| Static/build | Typecheck, web build, API bundle, conventions, and docs checks passed. |
| Docker | Browser, sandbox, workspace preparation, and prebuild stages passed. Nested execution now probes filesystem execution before selecting fuse-overlayfs. |
| Kubernetes | Lifecycle, execution, provider, conformance, and real image build stages passed after local disk repair and expansion. The image test requires a successful push. |
| PostgreSQL | Store and API stages passed using an isolated temporary database and a free loopback port. |
| Gateway | The latest full run passed. An earlier run had one `socket hang up`; its targeted rerun and 20 repeated suites passed. The earlier intermittent cause remains unexplained. |
| Credential-dependent stages | Nine stages skipped for missing credentials or opt-in. A passing stage can also contain skipped tests; the nested-Docker-specific suite skipped its tests. |
| Bounded rollback | Four processes exercised old code, current code, old code again, and current verification against one isolated database. See the rollback record. |

## Deployment

A clean production build found an undeclared `zod` import in the web package.
The web package now declares this dependency directly; existing local dependencies had concealed the missing declaration.

## Upgrade from dev-v2

A database from the multi-assistant model boots and keeps working. Each item below has a regression test.

| Stored state before upgrade | Handling |
| --- | --- |
| Several assistant rows for one owner | The singleton cutover keeps one row (live first, then the old default, then the newest) and moves the others to a `<owner>:retired:<id>` owner key. No row or history is deleted. |
| Only an archived row for a user, team, or org that still exists | The cutover and `resolveDefaultAssistant` restore it. An archived row whose team is gone stays retired, because team teardown deletes the team row in the same transaction. |
| Event rule targets with `assistantId` | Boot strips the field. PATCH drops it before validation and accepts `assistantId: null` as a clear, so these rules can be edited and disabled. |
| Workflows with `orchestrator` steps or a top-level `assistantId` | The step keeps its stored type, `orchestrator`, so dev-v2 can still validate and run it after a rollback. The app labels it "Thread". Boot drops the top-level `assistantId` from stored definitions, versions, run snapshots, and saved templates with `normalizeLegacyDefinition`. dev-v2 reads a definition without it as the owner's default. Boot also turns `thread` steps written by an earlier build of this branch back into `orchestrator`. New writes refuse `thread` and an explicit `assistantId`. |
| In-flight workflow runs started from a chat with a retired assistant | The next Thread step reports on the run's own thread in the workspace runtime. The retired chat does not receive the report. |
| Team members before `team_dm` existed | The `team_dm` column repair turns team DM copies on for every kind for members present at upgrade. Later members start with the opt-in default. |

These behavior changes are intentional and need a release note:

- `follow: true` now binds a reply thread only for `slack.app_mention` deliveries. A stored `slack.message` rule with `follow: true` receives only the replies that match its own filters. The earlier behavior delivered each matching reply twice. Existing follow bindings remain. The web UI never created this combination; find API-created rows with `target->>'follow' = 'true'` and `event_keys` containing `slack.message` but not `slack.app_mention`.
- Subscriptions, follow bindings, and workflows no longer select an assistant. Each workspace has one.
- Conversations with a retired assistant stay in the database, but the app cannot show them. No thread list includes them, and an archived assistant's session never wakes to serve its messages. A followed Slack thread that was bound to a retired assistant continues in the workspace runtime without the earlier conversation.

A workflow Thread step that is the first activity in a team now records the runtime's API session, so the run's threads and artifact publishing work before anyone opens the workspace.

## Evidence boundaries

Live Slack delivery and a real Slack button interaction remain unverified pending installation of the XORS app.
Local signed-request and transport fixtures prove routing and authorization, not live provider availability.

The rollback harness exercises actual prior service and storage code in separate processes.
It does not exercise a complete prior API and web deployment.
See [bounded rollback validation](2026-09-29-thread-rollback.md).

Local browser verification remains blocked by an invalid checkpoint record in the existing PGlite database.
Fresh test databases boot. The original database remains untouched; recovery is not verified.

The local Kubernetes disk now has free space and reports `DiskPressure=False`.
The repaired disk has a retained backup. No user containers or volumes were deleted.

Ticket coverage must follow these boundaries. Do not report skipped checks or local fixtures as live-provider acceptance.

Organization Linear app setup now uses encrypted credentials, admin-only controls, and serialized configuration updates.
The change is pushed to the matching branch in both Turnkey and XORS repositories.
