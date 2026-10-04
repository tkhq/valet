# Atomic workflow approval resolution

The workflow approval service commits the resolution signal, permission grants, audit outcome, and durable wake flag in one database transaction.

The signal's unique run and signal key selects one winner. Only the caller that inserts the signal can write grants or change the audit outcome. A conflicting decision returns `already_resolved`. An identical concurrent retry can report success without writing another grant.

Shared-account approvals still require the named account owner. They grant access only for the current workflow run, regardless of the requested permission scope. The borrow grant now commits with its approval signal. Run-scoped action grants use the same transaction. Permanent workflow grants retain the locked definition comparison before permission writes.

If a grant write fails, the transaction leaves no resolution signal, grant, audit change, or wake request. The member can retry the approval. If the process stops after commit, the persisted wake flag lets the workflow host recover the approved run. The service also wakes the local host after commit.

## Validation

Failure injection reproduces the previous partial commit for both borrow grants and run-scoped action grants. Regression tests verify complete rollback and successful retry. Concurrent denial tests verify that a losing approval creates no grant and cannot replace the denial audit outcome.
