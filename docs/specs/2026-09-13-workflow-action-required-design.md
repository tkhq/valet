# Workflow action required surface

Status: implemented.
Date: 2026-09-13.
Related: `2026-08-14-workflow-approval-ux-design.md` and
`2026-08-17-workflow-permissions-preview-design.md`.

## Problem

A person can only find a parked workflow gate from a notification or run page.
The Workflows hub has no list of active decisions across workflows.
Policy gates and workflow approval nodes also have different effects.
A shared label can hide that difference and cause an unsafe decision.

## User outcome

The Workflows hub shows a **Needs your approval** tab with a live count.
The tab lists every active gate that the caller can resolve.
The oldest gate appears first.
A notification opens this tab and focuses the matching gate.

The tab is global across the caller's reachable workflows.
This choice prevents the workspace switcher from hiding an urgent request.
Each row shows its personal or team owner to preserve context.
The existing per-run page remains the detailed run history.

## Gate semantics

The UI uses two distinct labels and card styles.

| Gate class               | Label             | Valid actions                                             | Effect                                                                        |
| ------------------------ | ----------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Workflow `approval` node | Workflow approval | Approve or deny                                           | Approve continues past the authored decision. Deny follows the node behavior. |
| Tool policy gate         | Tool permission   | Approve once, approve for this run, always allow, or deny | Approval authorizes the blocked tool action at the selected scope.            |

The policy card keeps **Approve once** as the default.
Only an org admin can select **Always allow**.
That action writes persistent org policy and links to policy settings.
The UI does not send a person to settings for per-run approval.

The action-required surface confirms approve and deny actions.
Each confirmation states the immediate effect.
The existing server route derives policy grants from the parked node.
The client cannot request a grant for a different action.

## Item content

`GET /api/workflows/action-required` returns one item for each pending gate.
Each item includes these fields:

- Workflow id and name.
- Run id, creation time, and owner.
- Blocked node and gate class.
- Approval prompt or policy service and action.
- Policy risk, provenance, parameters, and deny behavior when present.
- Safe trigger type and trigger id.
- Gate creation time for the waiting duration.
- The assistant the run executes as, when its definition snapshot names one.

The assistant comes from the RUN's definition snapshot, not from the
definition as it stands now. A run keeps the definition it started with, so a
re-pin while the run waits must not change the assistant this list reports.
The item omits the field when the snapshot pins none, and when the snapshot
names an unusable id. The row still lists in both cases: its approval is the
only way that run settles.

The API excludes trigger data and trigger metadata.
Those values can contain message bodies, credentials, or external payloads.
Policy gate parameters use the existing truncated gate projection.
The run page remains the authorized source for more context.

## Authorization and existence hiding

The list starts from workflow ids that the caller can read.
A personal run is visible only to its owner.
A team run is visible to current team members because the team is the principal.
A former member loses access immediately.
The API does not reveal excluded run ids, workflow names, or counts.

Only org admins see gates on org-owned runs.
The list uses the same action authorization as the resolution route.
The resolution route repeats the authorization check.
An unreadable run returns `404`, which matches a missing run.
Org admin status does not grant access to another person's run.
A policy gate also requires a human web principal.

## Refresh and notifications

The query polls every five seconds while the Workflows hub is open.
A successful resolution invalidates the run, run lists, and action-required list.
A raced `409` also invalidates the action-required list.
The item disappears after the run consumes the resolution and leaves its wait.
The run page then shows the checkpoint outcome.

The existing approval attention event remains the only notification event.
Its dedupe key is unchanged.
Only its deep link changes:

`/workflows?tab=action-required&run={runId}&gate={nodeId}`

The search values focus one list row.
The notification system does not create a second message.

## Mobile behavior

The tab strip scrolls horizontally and keeps a 44 pixel touch target.
An item changes from two columns to one column below the `sm` breakpoint.
Long workflow names, run ids, and action ids wrap instead of widening the page.
Buttons keep the existing mobile touch target.

## Test vectors

| ID   | Setup                                            | Action                     | Expected result                                                                 |
| ---- | ------------------------------------------------ | -------------------------- | ------------------------------------------------------------------------------- |
| AR-1 | One approval node and one policy gate are parked | List action-required items | The response contains both classes and a count of two.                          |
| AR-2 | Another user owns a parked approval              | List as the caller         | The response excludes the run and does not change the count.                    |
| AR-3 | The caller posts to the other user's gate        | Approve                    | The route returns `404`.                                                        |
| AR-4 | A notification contains a run and node target    | Open the deep link         | The action-required tab opens and highlights that row.                          |
| AR-5 | An approval node is visible                      | Select Approve             | No request occurs before confirmation. The confirmed request approves the node. |
| AR-6 | A policy gate is visible                         | Inspect actions            | The UI shows tool permission scopes and policy-specific consequences.           |
| AR-7 | A resolution succeeds or races                   | Observe query cache        | The action-required query invalidates and refreshes.                            |
| AR-8 | The viewport is narrow                           | Render the tab             | Cards stack, identifiers wrap, and controls retain touch targets.               |
| AR-9 | A run is parked, then its workflow is re-pinned to another assistant | List action-required items | The item reports the assistant from the run's snapshot. A snapshot with an unusable id reports none and still lists. |

## Scope

This change adds the cross-workflow action surface, wire projection, deep link,
and focused confirmation behavior.
It does not redesign the workflow editor or change policy precedence.
It does not add a second notification channel.
