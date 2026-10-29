# Turnkey Secrets for Valet — Design

**Date:** 2026-10-29
**Status:** Draft for review

## Overview

Valet sandboxes need secrets, such as the credentials that run the mono local
stack, and each user's own development keys. Today those come from 1Password.
This design stores them in Turnkey Secrets instead.

- **Where secrets live.** Company-wide secrets live in one Turnkey parent
  organization, `valet-turnkey-secrets`. Each Valet user's personal secrets
  live in that user's own sub-organization, created the first time it is
  needed. Valet keeps no copy of any value.
- **Who holds the keys.** One Turnkey API key, the Valet broker key, held by
  the Valet API. It is root in the parent and in every user sub-organization.
- **Who decides access.** Valet. The broker checks which session may read or
  change which secret before it calls Turnkey. Turnkey policy does not repeat
  that check, because root bypasses policy.
- **What Turnkey adds.** Encrypted storage, a hard boundary between users'
  secrets, and a record of every export naming the Valet user and session
  that asked.
- **If the broker key is stolen.** The thief can read and change every secret
  in every organization. Protecting that key is the main control.
- **What this does not do.** It does not hide a secret from the process that
  receives it.

This spec covers the Turnkey side in detail and the Valet side at a high
level. The Valet implementation is a follow-up.

## Valet architecture

```
Sandbox                         Valet API                          Turnkey
valet-secrets run               sandbox secret broker
  --env X=turnkey://NAME          │                                  │
  -- cmd                          │                                  │
   │── resolve, sandbox token ───►│ who is asking: user, session     │
   │                              │ may this session read NAME?      │
   │                              │ which org: parent or user's      │
   │                              │   sub-org (created if missing)   │
   │                              │── export, request_context ──────►│ decrypt to a
   │                              │◄──────── encrypted value ────────│ one-time key
   │◄────────── value ────────────│ decrypt in memory                │
   │ put X in cmd's environment,                                     │
   │ drop the sandbox token, run cmd                                 │
```

- **Sandbox.** Runs agent code and holds only its sandbox token, which is
  scoped to one session and expires. `valet-secrets run` already works this
  way for 1Password references. It gains `turnkey://` references.
- **Valet API.** The sandbox secret broker authenticates the sandbox token,
  decides access, picks the organization, and is the only component that holds
  the broker key and talks to Turnkey.
- **Valet database.** Maps each Valet user to their sub-organization. It holds
  no secret values.
- **Personal secret entry.** In the Valet UI, the browser encrypts the value to
  a Turnkey enclave key, so plaintext never reaches the Valet API. The API
  submits the import into the user's sub-organization.

## Organizations

```
valet-turnkey-secrets            company secrets
│   root: valet-broker, administrators; threshold 1
├── valet-user-<VALET_USER_ID>   alice's personal secrets
│       root: valet-broker; threshold 1
└── valet-user-<VALET_USER_ID>   bob's personal secrets
```

- **Parent.** Created once in the Turnkey dashboard. Its root quorum is the
  broker user and the administrators, threshold 1, so either can act alone.
  Administrators manage company secrets with the existing `tk secret`
  commands.
- **User sub-organization.** The broker creates it with
  `CREATE_SUB_ORGANIZATION_V9`, with the broker as the only root user and the
  same API public key. Sub-organizations can only be created through the API,
  and there is no limit on how many.
- **One key everywhere.** The same P-256 key pair is the broker's API key in
  the parent and in every sub-organization. Rotating it means updating every
  organization.
- **No policies.** Every actor is root, and root bypasses policy.

The parent can list a sub-organization's secrets but cannot import, export, or
delete them. The broker does those as root in the sub-organization itself.
Deleting a sub-organization also needs the sub-organization's root, which is
the broker.

## Secrets

| Scope | Organization | Turnkey name |
| --- | --- | --- |
| Company | parent | `NAME` |
| Personal | the owner's sub-organization | `NAME` |

- Names are unique within one organization, so the organization is the scope
  and the name needs no prefix.
- Secrets are immutable. Rotation is delete, then import, with a short gap
  where the name does not exist.
- No static properties are used. There is no policy to read them.
- Activities in sub-organizations bill to the parent. The first 100 secrets
  are free. Whether that count spans sub-organizations needs confirming with
  Turnkey.
- `list_secrets` has no name filter and returns at most 100 per page, so
  finding a name means paging.

## Export and audit

An export carries a `request_context` of string pairs. The broker sends
`valet_user_id` and `valet_session_id`. Turnkey records the context with the
activity, which is the audit trail. Turnkey does not verify it.

The broker exports one secret per request, so one missing secret never blocks
another. A batch export is all-or-nothing.

## Security

- The broker key can read, change, and delete every secret, and add users and
  keys, in every organization. It lives with the other deployment secrets and
  never in a sandbox.
- A stolen broker key can add a key of its own and keep access after rotation.
  Recovery in the parent is through the administrators. Recovery in a
  sub-organization means deleting it and re-importing the user's secrets.
- A bug in Valet's access check can expose any secret to any session. Nothing
  in Turnkey catches it.

## Verification

Against a test parent with synthetic values:

1. An administrator imports a company secret with `tk secret import`, and the
   broker key exports it with a `request_context` that appears in the
   activity.
2. The broker key creates a user sub-organization with itself as the only
   root, imports a secret there, and exports it.
3. The parent cannot export the sub-organization's secret.

## Follow-up

Valet-side detail, specified separately: the access rules per scope, the
reference grammar and routing, the user-to-sub-organization table, the
personal secret entry flow and routes, the broker key's deployment
configuration, and tests.

## References

- Turnkey: [Managed Secrets](https://docs.turnkey.com/features/secrets),
  [sub-organizations](https://docs.turnkey.com/features/sub-organizations),
  [root quorum](https://docs.turnkey.com/features/users/root-quorum)
- `tk` repository: `docs/secrets.md`
