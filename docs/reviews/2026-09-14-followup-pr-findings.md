# Follow-up PR review findings

Base: `dev-v2` after #706 (`b2f74fdd2`). These findings cover #707, #705, #640, #639, and #548. Reusable approvals in #641 are reviewed separately.

## Findings for the authors

| PR | Finding | Repair and regression coverage |
| --- | --- | --- |
| #707 | The origin-thread change conflicts with #706. Both paths must stay usable. | Direct assistant calls reuse their exact origin. Unattended calls get one thread per run, which the settle hook archives. Routing tests cover both paths. |
| #707 | A team run can retain a personal origin after its actor leaves the team. Later output could disclose team work. | Check current membership before each personal-origin dispatch. A regression removes membership between dispatches. |
| #705 | A forged callback gate ID could recover another recorded prompt. | Require the callback's recorded prompt reference. A forged reference with a valid gate ID leaves the gate pending. |
| #705 | Cross-org and org-admin checks could be skipped once a workflow session had an app row. | Apply workflow ownership checks with or without a backfilled row. Cover cross-org, non-admin, nonmember, malformed reference, and forged action cases. |
| #640 | Live team-assistant actions need current actor membership. Workflow machine principals need separate treatment. | Preserve team ownership, recheck live actors, and retain trusted workflow/API-key behavior. |
| #640 | The ownership lock covered prompt schedules but omitted workflow-target schedules. Deletion during readiness checks could leave an orphan. | Lock both target kinds and recheck their existence. Deterministic tests delete the workflow or team before insertion. |
| #639 | Greedy content matching could consume a fresh row before a stronger ID or queue match. Distinct repeated prompts could disappear. | Reserve canonical IDs, then queue IDs, then content matches. Both stronger-match variants have regressions. |
| #639 | Reconciliation can move unresolved messages across canonical neighbors, particularly with tied timestamps or partial history. | Carry durable sequence numbers and both neighbor anchors through reconciliation. Preserve pending rows across bounded snapshots. |
| #548 | Retry notices exposed raw provider error text without a clear next action. | Include provider, delay, attempt count, and parsed request ID. Explain model switching without raw JSON. No additional blocking code defect found in this PR. |
| e2e runner | API bundling raced the web build and could fail while copying missing assets. | Run both builds sequentially before the parallel test pool. Pin their order in runner tests. |

## Consolidation on 2026-09-14 (evening)

A second review pass covered this branch and the bot PRs merged to `dev-v2` on 2026-09-14. Each fix below carries a regression test that failed before the change.

| Source | Finding | Repair and regression coverage |
| --- | --- | --- |
| #706 | All unattended runs of one definition shared one assistant thread in followup mode. One pending approval held every later run of that definition, and the thread's Stop button aborted every queued run. | Each unattended run uses `signal:workflow:{runId}` again. The settle hook archives the thread when the run settles and the dispatched turn has settled. A test parks run A on a real approval gate and proves run B still settles. |
| #709 | Unattended team runs woke the team assistant with the synthetic `team:{id}` actor, and the new membership check refused every workflow tool. | A machine principal id is trusted; a human actor still needs membership. Routing and engine-deps tests cover both. |
| #709 | Origins recorded through the assistants table were resolved with a prefix parse, so migrated `orchestrator:*` assistants failed every orchestrator node. | Origins resolve through `loadAssistantBySessionId`. |
| #709 | An archived or missing origin thread absorbed the reply. | Origin validation requires an unarchived mirror row and an existing engine thread, else the run uses its own thread. Retry drops a dead origin. |
| #702 | Slack had no `answerCallback`, so every refused click was silent. Withdrawn and expired gates kept live buttons and leaked map entries. The approval DM path could throw and drop the DM. | Slack answers through the payload's `response_url` with a `chat.postEphemeral` fallback and a host allowlist. The host settles cards on `decision_gate_withdrawn` and `decision_gate_expired`. The DM path authorizes inside one guard and always sends the summary. |
| #689 | Errored and aborted assistant messages were reply targets. | Only `stopReason === "end_turn"` messages are reply-eligible, on REST, on the live stream, and on the reply route. |
| #683 | The Integrations reconnect returned with a query parameter the page never reads. | The integrations destination redirects with `?connected=github`. |
| #640 | Team event triggers and subscriptions inserted without the team ownership lock. | Both inserts run inside `withAuthorizedTeamOwnership` and recheck the target workflow and assistant under the lock. |
| #688 | Full saves accepted models the organization disabled or did not approve. Preset tiers validated without a usable provider. `update_model` left `ui.defaultModel` stale. | Full saves validate against the organization's active and approved set, tiers only when their first active target has a key, template install refuses a definition the organization cannot run, and a whole-workflow model update moves the editor default. |
| Editor | A camera move rebuilt `ui` without spreading it and dropped `ui.defaultModel`. | `setViewport` spreads the existing `ui`. |
| #697 | A broken team credential delegation threw before the organization fallback, while the catalog reported the organization bot as connected. | Resolution falls back to the organization row on `CredentialReferenceBrokenError`. The catalog reads the team row first. |

Findings verified but deferred: the action-required list fetches each parked run twice on a 5s poll (#690); `skills.list_skills` ignores the assistant skill allowlist for names and descriptions (#700); `readEntries` has no SQL limit (#689); Docs preview view modes return indices from a different index space and inline suggestions concatenate without markers (#699); edge selection is lost on a flow rebuild (#696); release workflows do not depend on CI and the ruleset has no required checks (#703).

## Scope and evidence

The review used PR descriptions, current source, design specs, and regression tests. TKAI-325 provides the retry-diagnostic intent. No new Linear ticket content was retrieved in this pass.

Do not merge the original PRs alongside this consolidation. After this replacement lands, close #707, #705, #640, #639, and #548 as superseded.

## Validation

Final validation results will be recorded before this PR is marked ready. Live Slack interaction requires a staging check. Automated callbacks use a fake transport and the real authorization and gate paths.
