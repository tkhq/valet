# Workflow approval UI cleanup

`ApprovalCard` and `PolicyGateCard` share `useApprovalResponse` for notes,
selected/submitted responses, and mutations. Responses include node ID and
iteration; notes are trimmed. Ordinary workflow approval submits directly,
without a second confirmation. `PolicyGateCard` retains once/run/workflow scopes,
named-lender checks, and confirmation for workflow-wide permission. Denials use
once scope; ordinary approvals omit scope. Canceling a confirmation submits nothing.
The mutation owns cache updates and stale-gate invalidation; authorization is unchanged.

Only a user principal can approve lending their account, with current organization
and team membership. Team API keys cannot act as their creator. Named approvers
have access to their pending gate, without access to private history, inputs, or
other gates. The notification bell omits navigation when `canOpenThread` is false.

`DecisionGateCard` follows the composer's 52rem column and responsive gutters,
using shared card, badge, button, and input primitives. Neutral approval badges,
a hand icon, full wrapped reasons, and policy provenance remain visible. Denial
is secondary; offered primary actions retain their styling and order.
Pending responses disable actions, announce progress, and show only the selected
spinner. Errors are alerts; retries retain input. Questions keep accessible names
and the keyboard submission shortcut. Named requests use the same chat column.

Targeted tests cover payloads, scopes, note trimming, iterations, cancellation,
pending/error recovery, keyboard submission, named approvers, and private navigation.
Visual checks cover narrow/wide panels, themes, and long reasons.
