# Turnkey Secrets for Valet — Design

**Date:** 2026-10-29
**Status:** Draft for review

## Overview

Valet sandboxes need secrets, such as the credentials that run the mono local
stack. Today those come from 1Password. This design stores them in Turnkey
Secrets instead.

- **Where secrets live.** One Turnkey organization, `valet-turnkey-secrets`.
  Valet keeps no copy of any value.
- **Who manages them.** The human administrators, who are the organization's
  root users. They add and remove secrets with the existing `tk secret`
  commands.
- **Who reads them.** One non-root Turnkey user, `valet-broker`, whose API key
  the Valet API holds. A single policy lets it export secrets and do nothing
  else.
- **What Turnkey records.** Every export, with the Valet user and session that
  asked.
- **If the broker key is stolen.** The thief can read secrets. They cannot add
  users, change policy, or import or delete secrets. Only the administrators
  can.
- **What this does not do.** It does not hide a secret from the process that
  receives it, or from the administrators.

This spec covers the Turnkey side: the organization, the broker, the policy,
and how to check them. How the Valet API calls Turnkey is a follow-up.

## Organization

| Piece | Setting |
| --- | --- |
| Organization | `valet-turnkey-secrets`, created in the Turnkey dashboard |
| Root quorum | The administrators, threshold 2 when there are at least two, otherwise 1 |
| Broker | User `valet-broker` with one API key, not in the root quorum |
| Policy | The one below |

Root quorum bypasses policy, and only the root quorum can change its own
members, so the broker is never root. Everyone else, including the broker, is
denied by default.

```json
{
  "policyName": "valet-broker: export secrets",
  "effect": "EFFECT_ALLOW",
  "consensus": "approvers.any(u, u.id == '<BROKER_USER_ID>')",
  "condition": "activity.type == 'ACTIVITY_TYPE_EXPORT_SECRETS'"
}
```

Listing needs no policy: every user can read metadata in their own
organization. Import and delete are not in the policy, so the broker cannot do
them. Administrators do, as root.

A user may change its own credentials, so a stolen broker key can add a second
key to the broker user. That keeps only broker access. An administrator ends it
by deleting the broker user and creating a new one.

## Secrets

- An administrator imports with `tk secret import --name NAME`. Plaintext is
  encrypted on the administrator's machine and never passes through Valet.
- `NAME` is unique in the organization. A name that is a valid environment
  variable name (letters, digits, underscore, no leading digit) can be used as
  the variable directly.
- Secrets are immutable. Rotation is `tk secret delete`, then
  `tk secret import`, with a short gap where the name does not exist.
- No static properties are used. The policy does not read them.
- The first 100 secrets are free. More requires contacting Turnkey sales.
- `list_secrets` has no name filter and returns at most 100 per page, so
  finding a name means paging.

## Export and audit

An export carries a `request_context` of string pairs. Valet sends
`valet_user_id` and `valet_session_id`. Turnkey records the context with the
activity, which is the audit trail. Turnkey does not verify it, and the policy
does not read it.

The broker exports one secret per request, so one missing or denied secret
never blocks another. A batch export is all-or-nothing.

## Verification

Run with `tk` profiles for an administrator and for the broker, against a test
organization with synthetic values:

1. Administrator: `tk secret import --name TEST_VALUE` succeeds, and
   `tk secret list` shows the name without the value.
2. Broker: `tk secret export --name TEST_VALUE --context valet_user_id=u1
   --context valet_session_id=s1` returns the value, and the activity shows
   both context pairs.
3. Broker: `tk secret import`, `tk secret delete`, and creating a user or
   policy are all denied.
4. Broker: `tk secret list` succeeds.

## Follow-up

Valet-side work, specified separately: the broker resolving `turnkey://`
references, accepting them in `.valet/credentials.yaml`, the deployment
configuration for the broker key, and tests.

## References

- Turnkey: [Managed Secrets](https://docs.turnkey.com/features/secrets),
  [root quorum](https://docs.turnkey.com/features/users/root-quorum),
  [policy language](https://docs.turnkey.com/features/policies/language)
- `tk` repository: `docs/secrets.md`
