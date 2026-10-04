# Workflow approval UI cleanup

## Scope

ApprovalCard and PolicyGateCard share response state through `useApprovalResponse`.
The hook owns the note, confirmation selection, submitted response, and approval mutation.
It trims notes and includes the node ID and iteration when it submits a response.
Cancel closes the confirmation without submitting. Confirm submits the selected response and closes the dialog.

Each card keeps its actions, confirmation text, pending presentation, and error messages.
PolicyGateCard keeps its credential approver access check and its once, run, and workflow scopes.
Workflow permission always requires confirmation. Denial submits the once scope.
ApprovalCard continues to omit scope. DecisionGateCard remains separate.

PolicyGateCard uses the existing Input primitive and gives the optional note an accessible name.
The approval mutation still owns cache updates and error invalidation, including stale gate responses.
The shared response hook does not change authorization.

## Validation

Existing approval and policy gate tests cover response payloads, scopes, errors, and rendering.
Regression tests cover canceled confirmations, subsequent denials, note trimming, iterations, pending actions, and credential approver access.

## Named account approvals

Only a user principal can approve lending that user's shared account. A team API key cannot act as its creator.
Named approvers retain decision-only access to private-origin workflow sessions while their gate is pending.
Organization and current team membership checks still apply. Other gates, thread history, and workflow inputs remain private.
The notification response marks whether the approver can open the thread. The bell omits links to inaccessible threads.
