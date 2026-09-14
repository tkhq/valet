# Scoped workflow approval review

This replaces #641 on top of the runtime repairs in #709. It must receive separate approval before merge.

## Findings

| Severity | Finding in #641 | Repair |
| --- | --- | --- |
| High | Credential identity omitted encrypted token content. Replacing a credential could retain a remembered grant. | Hash the encrypted credential snapshot and bind the resolved credential used by execution. Test rotation without timestamp changes. |
| High | Delegated and external vault credentials can change without a local row update. | Refuse reusable grants when identity cannot be pinned safely. One-time and run-scoped approval remain available. |
| High | GitHub credential selection could differ from the fingerprint selector, including team API keys and lazy installation fallback. | Match selection semantics and pin both credentials when an action can use installation fallback. |
| High | Approval management checked the workflow but did not scope rows to the grant's organization and principal. | Scope lookup and mutation to the organization and authorize the grant principal. Require an org admin to revoke org grants. |
| High | The resolution signal committed before the reusable grant. Failure or restart between writes could lose the remembered approval. | Commit the signal and grant in one transaction. A failed grant write rolls back the signal. A competing denial cannot produce a grant. |
| Medium | Rebasing onto the merged confirmation flow described reusable approval as a one-time action. | Describe the reusable action and maximum 90-day duration. Test confirmation before mutation. |
| Medium | Expired-row cleanup crossed organization boundaries. | Restrict cleanup to the grant's organization. |

## Validation

The focused API tests passed before stacking: 126 tests, including eight integration scenarios. These cover reuse, credential rotation, policy change, definition change, revocation, denial, and workflow isolation. Atomic-write tests cover transaction rollback and a competing denial. The approval component suite passed 18 tests.

Browser verification passed with a local fixture: approval, reuse on the next run, revocation, fresh approval after revocation, and denial. An oversized-parameter gate refused reusable approval, then completed with one-time approval. See the PR Validation section for the final full-suite and CI results. Live Slack validation remains separate.

## Behavioral limits

A remembered approval applies only to the exact workflow version, node, action, parameters, principal, plugin version, credential identity, and policy revision. Credential refresh can require another approval. External or ambiguous credentials deliberately cannot use remembered approval.

The existing once/run/always approval paths retain their prior persistence sequence. This change makes the new reusable-workflow scope atomic; it does not claim to repair all existing approval scopes.
