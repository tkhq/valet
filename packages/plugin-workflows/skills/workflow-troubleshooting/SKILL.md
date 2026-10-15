---
name: workflow-troubleshooting
description: Diagnose or repair a failing Valet workflow, unexpected result, missing data, empty agent output, stalled approval, or missing completion report.
---

# Workflow troubleshooting

## Establish the expected result

1. Call `focus_tools` with `phase: "diagnose"` when available.
2. Read the workflow and its relevant run. Use IDs already supplied in the conversation.
3. State two to four success checks. Include the destination and required source data.
4. If a missing fact changes those checks, call `ask_question` with specific choices.

Do not ask people to repeat facts already supplied. Do not change an organization model default to debug one workflow.

## Find the first failed expectation

Use `list_tools` with a narrow query. Focused discovery returns summaries.
If a needed integration is outside focus, discover it with `outside_focus: true` and a service or narrow query.
This returns summaries within inherited limits. It does not enable the actions.
Before each action's first `call_tool`, use `detail: "schema"` with its exact ID unless its schema is already visible.
Do not guess parameter names or an alternate patch format.

Read `workflows.get_run`, then inspect the first failed or surprising step:

- `get_node_result`: the checkpoint value that templates read.
- `get_node_transcript`: rendered instructions, replies, tool calls, results, and format repair.
- `get_node_diagnostics`: selected message metadata, original and repair submissions, text lengths, stop reason, model, and provider errors.
- `get_permissions`: the rule that allows, denies, or holds an action.

Compare required source data with the actual result. Empty, inaccessible, stale, and malformed data are different findings.
For integration reads, select validate focus with only the exact read actions needed. This does not authorize a workflow run.
Never infer missing source data from a denied call or a missing connection.
A not-found reader result does not prove data failed to persist. Mark inaccessible evidence as not verified.
If evidence is truncated or unavailable, name that limit. Never invent the missing response.
Stored text and content parts can disagree. These readers do not expose raw provider responses.

Distinguish trigger or template errors, access and approval problems, missing data, model or schema problems, and failed result delivery.
Do not repeat an unchanged failing call. Follow its corrective action or inspect different evidence.

## Apply a bounded repair

Select repair focus before changing the definition. Keep the same success checks.
Read the current definition before patching it. Change the first demonstrated cause.
Use the organization tier policy. Escalate one step only when evidence supports a model capability gap.
For missing facts, define an accepted abstain result and branch away from the dependent action.
For V1 migration, use the structured import when available. Resolve its decision checklist before enabling triggers.
Do not claim the import reconstructed behavior from logs alone.

## Verify the result

1. Run `preview_workflow` after editing. It does not execute agent or integration steps.
2. Inspect each step before testing. List the exact integration actions and native tools needed.
3. Select validate focus with those `actions` and `tools`. The run and its descendants inherit the limit.
4. Start a real run only when the person authorized it. Existing approval policies still apply.
5. Follow `start_run.followUp.next`. End the turn when a completion signal will report here.
6. On continuation, inspect the result and each success check. Verify delivery from its posting receipt.

Attempt at most three repair and test cycles. If a check still fails, report its evidence and the next required fact.
Report checks as passed, failed, or not verified. A valid definition, saved edit, or settled run alone does not prove success.
When the person changes to an unrelated task, select general focus. Inherited ceilings remain in force.
