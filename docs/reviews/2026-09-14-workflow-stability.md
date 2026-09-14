# Workflow stability review, 2026-09-14

## Scope and merge control

Base: `dev-v2` at `1cf92df4dd4ffe280a5dd267f46a342e4c461197`.
This report records PR intent, confirmed findings, and remaining validation.
The owner requires explicit approval before every further PR merge.
This branch is a draft. It does not import the open feature PRs.

## Intent from Linear and PR descriptions

| Source | Intended behavior | Review result |
| --- | --- | --- |
| [TKAI-469](https://linear.app/turnkey/issue/TKAI-469/slack-workflow-approval-callbacks-do-not-resolve-workflow-owned-gates), [#702](https://github.com/tkhq/valet/pull/702) | Authorized owners or members resolve workflow session gates from Slack exactly once. Invalid actions and restore failures leave the gate pending. | Merged with callback serialization and restore-error repairs. Live Slack validation remains outstanding. Follow-up #705 is open. |
| [TKAI-470](https://linear.app/turnkey/issue/TKAI-470/workflow-canvas-edges-do-not-clearly-convey-direction-or-decision), [#696](https://github.com/tkhq/valet/pull/696) | Directional edges, clear branches, accessible full conditions, separated labels, and consistent previews. | Merged. Fixed unintended node deletion when selecting an edge label. Browser regression passed. |
| [TKAI-325](https://linear.app/turnkey/issue/TKAI-325/transient-retry-error-message-leaks-raw-json-and-does-not-name-the), [#548](https://github.com/tkhq/valet/pull/548) | Explain upstream overload, retry delay, and corrective action without raw provider JSON. Preserve request IDs for support. | Relevant open PR. Do not confuse this message-only change with provider failover. Code review remains outstanding. |
| [#641](https://github.com/tkhq/valet/pull/641) | Reuse an exact, scoped tool approval for unchanged recurring actions. Current deny policies still win. Allow expiry and revocation. | Open. Security repairs exist in an isolated worktree and need integration and review. They are not on the base branch. |
| [#640](https://github.com/tkhq/valet/pull/640) | Preserve assistant ownership, check current membership, and serialize resource creation with team deletion. | Open. Revised against current actor and routing behavior. Latest rebase needs final validation. |
| [#690](https://github.com/tkhq/valet/pull/690) | Show actionable explicit approvals and tool gates with distinct context. | Merged after filtering out gates the requester could read but could not resolve. |
| [#689](https://github.com/tkhq/valet/pull/689), [#639](https://github.com/tkhq/valet/pull/639) | Preserve reply quotes through persistence; reconcile canonical and optimistic messages without reordering or duplication. | #689 merged; #639 remains open. The requested landing order was not followed. Combined reconciliation validation is outstanding. |
| [#699](https://github.com/tkhq/valet/pull/699) | Let Docs readers choose suggestion handling while retaining the API default when omitted. | Merged after changelog repair. Targeted tests passed. No code defect found in that review. |
| [#643](https://github.com/tkhq/valet/pull/643) | Expose the existing workflow-copy tool to personal assistants without changing its authorization. | Merged with current test fixtures. |
| [#688](https://github.com/tkhq/valet/pull/688) | Recommend approved models, retain explicit overrides, and apply focused workflow updates. | Merged after fixing test mocks, custom-model validation, bare-ID provider routing, and changelog metadata. |
| [#650](https://github.com/tkhq/valet/pull/650) | Keep personal settings reachable without clearing the selected team. | Reduced to navigation after #700 superseded skill discovery. Merged; browser checks passed. |
| Owner's thread-growth report | Stop recurring runs from creating an assistant thread for every run. | This branch proposes one thread per workflow definition within the selected assistant. |

The three linked Linear tickets above were read directly. Other rows use PR descriptions and repository specs; a matching Linear ticket was not verified.

## Confirmed findings and fixes

1. **Release CI missed a web compile error.** After #683 changed the OAuth hook, Connected Accounts omitted the required mutation argument. Root typecheck excluded web. #703 supplied `undefined`, updated assertions, and added the production web build to CI.
2. **Workflow runs create unbounded thread rows.** The dispatcher used `signal:workflow:{runId}`. This branch reuses `signal:workflow:definition:{workflowId}`. Run IDs remain in signal attributes and dispatch IDs. Existing run threads retain their receipts on retry.
3. **Thread reuse requires narrower cancellation.** Workflow cancellation previously aborted a whole thread. This branch passes the queue-item ID through cancellation, stop, and foreach failure paths. Store scope includes session, thread, and item. Other submissions continue.
4. **#696 could delete an unrelated selected node.** Edge-label selection did not clear node selection. The merged fix clears it. Browser verification covered node selection, edge-label selection, Backspace, and Cancel restoration.
5. **#688 rejected valid custom models.** Validation used the bundled catalog instead of organization model configuration. The repair shares organization-aware validation across HTTP and assistant updates.
6. **#688 could route bare provider model IDs incorrectly.** A bare OpenAI or Google model ID could first select the disabled Anthropic provider. The repair resolves bundled provider identity before model selection.
7. **#688 shipped incomplete test mocks.** Newly used model hooks were absent from editor and index mocks, causing 21 test failures. Two commits also lacked required changelog metadata.
8. **#690 listed gates without action authorization.** Read access to an organization workflow did not imply permission to resolve its gates. The merged list applies action authorization.
9. **#702 callback aliases could bypass per-gate serialization.** Different prompt references can represent one gate. The repair keys serialization by the recorded gate ID. Workflow restoration failures now answer the callback instead of escaping to a log-only handler.
10. **#641 did not bind approval reuse to credential generation.** Replacing an API key can preserve row creation time and metadata. The original fingerprint could reuse the old grant. Draft repairs hash credential identity and pin the actual resolved credential for execution.
11. **#641 missed indirect credential changes.** Delegated and vault references can change independently. Team GitHub keys and lazy installation fallback also need explicit handling. Draft repairs refuse ambiguous identities and bind actual credential resolution.
12. **#641 approval visibility used the workflow's principal.** Shared definitions could expose another user's approval metadata, while a member could not revoke their own grant. Draft repairs authorize each approval's principal and scope updates by organization, workflow, approval, and principal.

Items 10-12 concern the open #641, not code already merged into the base branch.

## PR disposition

Merged during this work before the owner changed merge policy:
#703, #699, #689, #690, #702, #688, #643, #650, and #696.
Each had passing hosted checks before its merge.

Closed as redundant or obsolete: #701, #382, and #383.
#701 changed fixture identities and wording without adding behavior or assertions.
#382 targeted the frozen worker stack.
#383 restored an older preference design superseded by model tiers.

The owner closed #698 as superseded by #700.
Replacement #704 retains only a reviewer-assignment template guard and remains open.
It requires an explicit relevance decision. Do not treat it as approval to restore #698.

Open and not merged here: #641, #640, #639, #548, #704, and #705.
#705 proposes additional Slack callback reference validation and uniform expired responses.
Its description and diff were read; its full review remains outstanding.

## Validation

The base commit's hosted CI, Remote Postgres, Docker Images, and Release CLI completed successfully.
A successful image build is not evidence of a completed production deployment.

Focused checks on this branch:

- Workflow engine adapter: 18 passed, 2 live integration tests skipped.
- Engine queue and in-memory store: 98 passed; the added approval-blocked cancellation case also passed (15 queue tests total).
- Workflow package: 433 passed.
- Postgres package: 148 passed, 119 environment-gated tests skipped.
- Root typecheck passed after the final cancellation test.
- GitHub action and token service suites passed an isolated rerun: 107 tests.

Overlapping runs of one workflow now share FIFO execution and conversation context. Different workflows retain separate threads.

The completed full `make e2e` run reported 22 passed, 4 failed, and 9 skipped. Its complete local log is `/tmp/workflow-stability-e2e.log`.
The baseline had a macOS `/bin/tar` failure, a CLI harness `tsx` path failure, and two Kubernetes transport assertions.
The current full unit sweep had two GitHub fixture failures; both suites passed the isolated 107-test rerun.
A baseline child-dismiss failure passed an isolated rerun. These do not yet constitute a clean local scorecard.

An attempted independent review agent was blocked by automatic safety review with “Potentially unintended activity.”
The agent was not retried. The new thread patch still requires independent review before merge.

## Review follow-up

The code review found a cancellation race during asynchronous model resolution.
A cancelled turn could start a model call after resolution returned.
A deterministic test reproduced the problem before the repair.
The engine now marks the live submission and rechecks durable abort intent before starting or resuming provider work.
The regression passes after the repair.
Cancel, stop, and foreach tests also assert the queue-item ID passed to the adapter.

Post-repair focused checks: 40 engine queue/gate tests and 38 workflow cancellation/foreach tests passed.
The isolated Kubernetes binary round-trip test still fails; this is unchanged code and reproduced in the prior baseline.
The local end-to-end requirement remains unsatisfied. Do not treat green hosted checks as a clean local scorecard.
