# Turnkey Secrets for Valet — Design

**Date:** 2026-10-29
**Status:** Draft for review

## Purpose

Store the secrets a sandbox needs, such as the credentials that run the mono
local stack, in Turnkey Secrets instead of 1Password.

Turnkey encrypts each secret, evaluates policy on every export, and logs who
asked. Valet keeps no secret values and no secret metadata of its own.

## Scope

- One Turnkey organization, `valet-turnkey-secrets`, holds every secret.
- `turnkey://NAME` references resolve through the existing sandbox broker.
- An operator command imports, lists, and deletes secrets.
- A one-time operator command moves the broker from root to a non-root user.

**Non-goals:** secret entry in the Valet UI; per-user or per-team
organizations; reading a secret value any way other than naming a destination
for it; writing to secrets from a sandbox.

## Decisions

1. **One organization, one broker.** The broker is a single Turnkey user,
   `valet-broker`, with one API key. Valet holds no other Turnkey credential.
2. **Valet is the authority on who may read.** The broker resolves a reference
   only for a sandbox principal in the Valet organization. Turnkey policy
   repeats that check (see Hardening).
3. **Plaintext never reaches Valet storage.** The operator command encrypts the
   value on the operator's machine before it leaves. The broker holds a value
   in memory for one request.
4. **No secret table.** Valet lists from Turnkey. The only new configuration is
   three deployment secrets, stored like `VALET_ENCRYPTION_KEY`:
   `VALET_TURNKEY_ORG_ID`, `VALET_TURNKEY_API_PUBLIC_KEY`, and
   `VALET_TURNKEY_API_PRIVATE_KEY`.

## Turnkey facts the design relies on

| Fact | Consequence |
| --- | --- |
| Secrets are immutable. Rotation is delete, then import. | `import --replace` deletes first and can leave a gap. |
| Names are unique within an organization. | The name is the identity. No ID mapping is stored. |
| Policy sees `secret.static_properties`, not the name. | Scope is written into static properties at import. |
| Policy does not apply to root users. | The broker must be non-root for policy to bind it. |
| Export takes a per-secret `request_context` that Turnkey records but does not verify. | The broker states who asked. Turnkey logs it and policy can compare it. |
| Export of a batch is all-or-nothing. | One denied secret rejects the whole call. |
| Listing has no name filter. | A lookup pages through the organization. Fine at this scale. |

## Secret model

The Turnkey name is `NAME`, matching `^[A-Za-z_][A-Za-z0-9_]*$`, the rule
`valet-secrets` already applies to `--env` names. The reference is
`turnkey://NAME`.

Static properties, written once at import:

- `valet_org_id`: the Valet organization ID.
- `created_by`: the operator who imported the value.

## Flows

### Import

    valet-turnkey import NAME < value

1. The command reads the value from stdin, never from an argument.
2. It submits `INIT_IMPORT_SECRETS` and receives the enclave target bundle.
3. It encrypts the value to that bundle with `encryptSecretToBundle` from
   `@turnkey/crypto`, which checks the enclave signature.
4. It submits `IMPORT_SECRETS` with the name and static properties.

`--replace` deletes the existing secret of that name first.

### Export to a sandbox

    valet-secrets run --env DATABASE_URL=turnkey://DATABASE_URL -- pnpm test

1. The sandbox sends its references to `POST /api/sandbox-secrets/resolve`,
   authenticated by the sandbox token as today.
2. The broker routes by reference prefix. `turnkey://` goes to the Turnkey
   provider. The existing `op://` provider is unchanged.
3. The provider maps each name to a secret ID by paging `list_secrets`.
4. It generates a one-time P-256 key and submits `EXPORT_SECRETS` for all
   names in one call, with a `request_context` per secret.
5. It decrypts in memory and returns base64 values in request order, the same
   response shape as today.

`request_context` carries `valet_org_id`, `valet_user_id`, and
`valet_session_id`, taken from the sandbox principal and never from the
request body.

### List and delete

`valet-turnkey list` prints names and static properties, never values.
`valet-turnkey delete NAME` deletes a secret. `valet-secrets find` searches
the same names.

## Hardening: non-root broker

At launch the broker is the root user with threshold 1. This is the shortest
path to a working integration, and it is a known weakness: root can add users,
add API keys, and change the quorum, so a stolen broker key lets an attacker
keep access after the key is rotated.

`valet-turnkey harden` closes this once, from the broker's own credential:

1. Add the human administrators as root users, using public keys pinned in
   deployment config. Valet routes cannot change that list.
2. Create the `valet-broker` tag, tag the broker user, and install the broker
   policies below.
3. Set the root quorum to the humans only. The threshold is 2 when there are
   at least two humans, otherwise 1.

After step 3 the broker is non-root. Root changes need the human quorum,
through the Turnkey dashboard. The command is safe to run again and checks the
resulting quorum and policies before it exits.

Broker policies, each with consensus
`approvers.any(user, user.tags.contains('<valet-broker-tag-id>'))`:

```json
{
  "policyName": "valet-broker: import and delete secrets",
  "effect": "EFFECT_ALLOW",
  "consensus": "approvers.any(user, user.tags.contains('<valet-broker-tag-id>'))",
  "condition": "activity.type in ['ACTIVITY_TYPE_INIT_IMPORT_SECRETS', 'ACTIVITY_TYPE_IMPORT_SECRETS', 'ACTIVITY_TYPE_DELETE_SECRETS']"
}
```

```json
{
  "policyName": "valet-broker: export secrets",
  "effect": "EFFECT_ALLOW",
  "consensus": "approvers.any(user, user.tags.contains('<valet-broker-tag-id>'))",
  "condition": "activity.type == 'ACTIVITY_TYPE_EXPORT_SECRETS' && activity.params.request_context['valet_org_id'] == secret.static_properties['valet_org_id']"
}
```

A missing `request_context` key makes the condition error, and an erroring
allow does not allow. A stolen broker key can still send false claims, so
this limits the key to the secrets activities and catches a Valet bug. It does
not make the key safe to lose.

## Security

- **The broker key is the trust point.** It reads every secret its policy
  allows. It lives with the other deployment secrets and never in a sandbox.
- **The sandbox holds only the sandbox token.** The token is scoped to one
  session and expires. A leaked token is worth its remaining lifetime.
- **Plaintext exposure.** At import, only on the operator's machine. At
  export, in broker memory for one request, then in the child process's
  environment. The child can print or transmit it, as with any injected secret.
- **Human roots can export any secret.** Secrets here are company secrets, not
  private from the administrators.

## Rollout

1. Create `valet-turnkey-secrets` with the broker key as the only root user.
2. Add the Turnkey provider to the broker, the `valet-turnkey` command, and
   `turnkey://` support in `.valet/credentials.yaml`.
3. Import the local stack secrets and move the mono workflow to `turnkey://`.
4. Run `valet-turnkey harden`.

## Acceptance

All against a dedicated test organization with synthetic values:

1. `import` stores a value. `list` shows its name and no value.
2. `valet-secrets run` gives a child process the exact value.
3. A resolve with a sandbox token from another Valet organization fails.
4. After `harden`, the broker key cannot add a user or API key, and the
   same `run` still succeeds.
5. After `harden`, an export whose `valet_org_id` differs from the secret's is
   denied.
6. `delete` removes the secret and a later `run` reports it unresolved.

## References

- `docs/specs/2026-09-01-sandbox-secret-broker-design.md`
- `packages/api/src/routes/sandbox-secrets.ts`
- `packages/api/src/engine/secrets-cli-script.ts`
- `packages/api/src/engine/credential-commands.ts`
- Turnkey: [Managed Secrets](https://docs.turnkey.com/features/secrets),
  [root quorum](https://docs.turnkey.com/features/users/root-quorum),
  [policy language](https://docs.turnkey.com/features/policies/language)
