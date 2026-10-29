# Turnkey Secrets for Valet — Design

**Date:** 2026-10-29
**Status:** Draft for review

## Overview

Valet sandboxes need secrets, such as the credentials that run the mono local
stack. Today those come from 1Password. This design lets them come from
Turnkey Secrets as well.

- **Where secrets live.** In one Turnkey organization, `valet-turnkey-secrets`.
  Valet stores no secret values and no secret records of its own.
- **Who puts them there.** Administrators, with the existing `tk secret`
  commands. There is no new tool and no Valet UI.
- **How a sandbox uses one.** A command names a destination and a reference:
  `valet-secrets run --env DATABASE_URL=turnkey://DATABASE_URL -- pnpm test`.
  The Valet API fetches the value from Turnkey and places it in that one
  command's environment. The agent never reads it.
- **Who can read them.** Any sandbox in the Valet organization, through the
  Valet API. Turnkey allows exactly one non-administrator identity, the Valet
  API's broker key, to export, and records which Valet user and session asked.
- **What an attacker gets from a stolen broker key.** The ability to read
  secrets, but not to add users or change policy. Only the human
  administrators can do that.
- **What this does not do.** It does not hide a secret from the command that
  receives it, or from the human administrators.

Setup is one manual step by the administrators, then a small change to the
Valet broker.

## Decisions

1. **One organization, one broker.** The broker is a Turnkey user,
   `valet-broker`, with one API key held as a Valet deployment secret.
2. **The broker is never root.** Administrators create the organization as
   root, add the broker as an ordinary user, and give it one policy. Root
   bypasses policy, so a root broker would be unrestricted.
3. **Administrators manage secrets, not Valet.** `tk secret import`, `list`,
   and `delete` run under the administrators' own Turnkey credentials. The
   broker never imports or deletes, so plaintext never passes through Valet at
   import.
4. **Valet decides who may read.** The broker resolves a reference for any
   sandbox principal in the Valet organization, the same trust the 1Password
   broker applies to its organization scope.

## Setup

Done once by administrators in the Turnkey dashboard:

1. Create `valet-turnkey-secrets`. The root quorum is the administrators, with
   threshold 2 when there are at least two.
2. Add the user `valet-broker` with a new P-256 API key. It is not in the
   root quorum.
3. Create this policy, with the broker's user ID substituted:

```json
{
  "policyName": "valet-broker: export secrets",
  "effect": "EFFECT_ALLOW",
  "consensus": "approvers.any(u, u.id == '<BROKER_USER_ID>')",
  "condition": "activity.type == 'ACTIVITY_TYPE_EXPORT_SECRETS'"
}
```

4. Store the organization ID and the broker's API key pair as the deployment
   secrets `VALET_TURNKEY_ORG_ID`, `VALET_TURNKEY_API_PUBLIC_KEY`, and
   `VALET_TURNKEY_API_PRIVATE_KEY`, and document them in
   `docs/environment-variables.md`.

Listing is not in the policy: every user can read metadata in their own
organization.

## Resolving a reference

The reference is `turnkey://NAME`, where `NAME` is the Turnkey secret name.

1. The sandbox sends its references to `POST /api/sandbox-secrets/resolve`,
   authenticated by the sandbox token as today.
2. The route splits references by prefix. `op://` goes to the existing
   1Password path unchanged. `turnkey://` goes to a new Turnkey resolver. A
   request that mixes them is resolved in one response, values in request
   order.
3. The resolver maps each name to a secret ID by paging `getSecrets` with the
   `after` cursor until the name is found. The SDK does not page by itself,
   and the list API has no name filter.
4. It calls `exportSecret({ secretId, requestContext })` for each secret. The
   context is `{ valet_user_id, valet_session_id }`, taken from the sandbox
   principal and never from the request body. Turnkey records it with the
   activity, which gives the per-export audit trail. Turnkey does not verify
   it.
5. The route returns base64 values and a `null` for a name nothing resolved,
   the same shape as today.

`.valet/credentials.yaml` currently rejects any reference that does not start
with `op://`. It also accepts `turnkey://`.

## Secrets

Names match the variable-name rule `valet-secrets` already applies:
letters, digits, and underscore, not starting with a digit. Secrets are
immutable and names are unique, so rotation is `tk secret delete`, then
`tk secret import`, with a short gap where the name does not resolve. See
`docs/secrets.md` in the `tk` repository for the commands.

## Security

- The broker key is the trust point. It lives with the other deployment
  secrets and never in a sandbox.
- A sandbox holds only its session token, which expires. Its `run` unsets the
  token before the child starts, as today.
- A broker-side bug could export any secret to any sandbox in the Valet
  organization. Turnkey policy does not check Valet's decision, so access
  control within the organization is Valet's alone.
- Turnkey lets every user change its own credentials, so a stolen broker key
  can add a second key to the broker user. The access it keeps is the
  broker's, and an administrator ends it by deleting and recreating the user.
- The receiving process can print or transmit the value.
- The administrator root quorum can export any secret.

## Acceptance

Against a test organization with synthetic values:

1. `tk secret import` stores a value, and `tk secret list` shows its name
   without the value.
2. `valet-secrets run --env X=turnkey://NAME -- env` gives the child the exact
   value, and the Turnkey activity log shows the user and session IDs.
3. After setup, the broker key cannot import, delete, create users, or edit
   policies.
4. A name that does not exist fails the run with the name in the error.
5. A command using both `op://` and `turnkey://` references receives both.

## References

- `docs/specs/2026-09-01-sandbox-secret-broker-design.md`
- `packages/api/src/routes/sandbox-secrets.ts`
- `packages/api/src/engine/credential-commands.ts`
- Turnkey: [Managed Secrets](https://docs.turnkey.com/features/secrets),
  [root quorum](https://docs.turnkey.com/features/users/root-quorum),
  [policy language](https://docs.turnkey.com/features/policies/language)
