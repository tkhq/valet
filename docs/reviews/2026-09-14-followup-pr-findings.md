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

## Scope and evidence

The review used PR descriptions, current source, design specs, and regression tests. TKAI-325 provides the retry-diagnostic intent. No new Linear ticket content was retrieved in this pass.

Do not merge the original PRs alongside this consolidation. After this replacement lands, close #707, #705, #640, #639, and #548 as superseded.

## Validation

Final validation results will be recorded before this PR is marked ready. Live Slack interaction requires a staging check. Automated callbacks use a fake transport and the real authorization and gate paths.
