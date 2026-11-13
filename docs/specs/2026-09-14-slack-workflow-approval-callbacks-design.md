# Slack workflow approval callbacks

Workflow session decision gates use the workflow run owner for callback authorization.
Personal owners and current team members can resolve their gates. Org-owned gates require an org admin.
Authorization reads the run, the workflow definition, and the owner's membership. It builds no session.
Only a callback that resolves a gate restores the workflow session, through the workflow session builder.
If restoration fails, the callback receives an actionable error and the gate stays pending.

The attention router sends the same approval to each recipient who may resolve the gate.
It authorizes a `wf:` session against the run, as the callback path does.
If that authorization fails, the recipient receives the plain summary with the web link, not silence.

Callbacks validate actions against the persisted pending gate.
The host serializes callbacks by the server-recorded prompt mapping and resolved gate id.
It never trusts a gate id from the callback payload for lookup or serialization.
This also covers transports whose callbacks carry only the message reference.

Malformed, stale, cross-org, and unauthorized callbacks receive the same expired response.
This prevents a callback from probing whether a gate or workflow session exists.
Drop logs retain the internal failure category for diagnosis: malformed, missing, deleted, or cross-org workflow sessions.
A workflow category applies only to a `wf:` session id. A click on any other id whose session row is absent is logged as unauthorized.

These callbacks resolve engine decision gates inside workflow sessions.

## Workflow step cards

A `tool` step held by policy and an `approval` step wait on a run checkpoint, not on an engine decision gate.
Until 2026-11-13, their attention DM was a plain summary, so a scheduled run could be answered only on the run page.

The attention DM for such a step is now a card with two buttons: Approve once and Deny.
Scoped choices (this run, this workflow, a shared account for the team) stay on the run page.
The channel host gets the run page's checks through a port (`channels/workflow-gates.ts`):

- `mayResolve` runs the access part of `resolveWorkflowApproval`. Only a recipient it accepts gets buttons. Every other recipient gets the plain summary.
- `resolve` calls `resolveWorkflowApproval` as the clicker, with scope `once` and `via: "channel"`. The run page's checks apply unchanged: run audience, named account approver, gate occurrence, and timeout.

The card's prompt key names the run, step, iteration, and gate occurrence.
The host records the card's callback address under that key, as it does for a decision gate, and saves it in `engine_decision_gate_refs`.
A restarted host restores the address only while the step still waits. It deletes the saved address of a finished step.

A click that decides the step settles every card for it.
A click on a step that another answer already finished also settles the card, and the reply says where to look.
A click that `resolveWorkflowApproval` refuses keeps the card, and the reply names who can answer.

Limitation: an answer on the run page does not edit the cards. A later click on such a card reports that the step was already answered and then settles that card.

## Rejections are visible on Slack

Slack acknowledges a button click with an empty body, so a refused click shows nothing by itself.
The Slack transport records the `response_url` of each parsed click, keyed by its trigger id.
When the host refuses a callback, the transport posts the reason to that URL as an ephemeral reply.
If the click carries no `response_url`, or the URL no longer accepts the post, the transport sends an ephemeral message to the channel and the clicker.
The transport posts only to a Slack host, so a payload that arrives without Slack's signature cannot aim the answer at another address.
A callback answered without text sends nothing, because the acknowledgement already stands.
Every failure to answer is logged and the callback continues, because the gate outcome is already decided.

## Withdrawn and expired gates

A gate can end without a decision. The engine withdraws a gate when the run is steered, aborted, or cancelled, and expires a gate that no one answers in time.
The host subscribes to both endings and settles the gate the same way a decision does.
It writes the outcome line onto every prompt message for the gate, and clears the gate from its prompt, reference, and action maps.
The buttons therefore stop accepting clicks when the run ends, and a long-lived process holds no state for a gate that is over.
