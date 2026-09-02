# Part 12: Security Engagement Credentials via 1Password

*Depends on: Part 00, Part 01, Part 04, Part 05, Part 09, Part 11. Also depends on `docs/specs/2026-07-21-onepassword-credentials-design.md` (PR #421) and the sandbox secret broker runtime (PR #421). Conformance: L1+ (config, preflight, broker allowlist); L3 pulls in the delivery path.*

## Purpose

Part 10 kept credentials in Postgres as ciphertext. It solved the plaintext leak on the flat needs-answer path, but it kept three problems: (a) a copy of every value lived in Valet, so teams already storing secrets in 1Password had to copy and rotate twice; (b) the persona sandbox mounted the plaintext as a file the agent could `cat`, so a prompt-injected persona could echo the value into a tool call or a message; (c) Valet's DB is now a target for a credential dump.

Part 12 removes the vault and consumes PR #421's 1Password + sandbox-secret-broker plumbing.

- Secrets stay in 1Password. Valet holds only the `op://vault/item/field` reference.
- The persona child sandbox NEVER mounts the value. `valet-secrets run --env NAME=op://... -- cmd` runs one shell child with the value in its env; the persona LLM never sees the bytes.
- The api-side broker rejects any resolve for a ref the engagement did not declare.
- Kind is explicit in the YAML and drives the shape check + the persona's usage hint.

Part 10's tripwire, `engagement_credentials` table, `EngagementVault`, vault wizard step, and vault wire routes are removed by this part. Part 10's kind schema and dispatch-prompt file-path rendering survive with modifications.

## Vocabulary

**op:// reference.** A 1Password locator of the form `op://<vault>/<item>/<field>[/<subfield>]`. The value is dereferenced at USE time via `OnePasswordService.resolveReference`. Nothing about the value is persisted; the reference is safe to store, log, and check into git.

**Engagement credentials.** A per-engagement list of `{label, kind, ref, refShape?, meta?}` declared in `.valet/security.yml` or added mid-run via the needs panel. Persisted as `security_engagements.credentials_json`. Ephemeral: dies with the engagement.

**Broker.** The sandbox-authenticated `POST /api/sandbox-secrets/resolve` route from PR #421. Called by the in-sandbox `valet-secrets` shell script. Returns base64-encoded values in a positional array.

**Broker allowlist.** The set of refs the engagement declared. The broker rejects any resolve request whose ref is outside the calling session's engagement allowlist.

**Preflight.** A validation pass at engagement start. Resolves each declared ref once, shape-checks by `kind`, drops the value. On failure the engagement refuses to start with a corrective error naming the label and the shape problem.

**Cred-typed need.** A `security_needs` row whose `kind` is `credential`. The resolve path appends `{label, kind, ref}` to `engagement.credentials_json`; the needs row stores `resolution = null` and `credential_ref = op://...`. There is no plaintext value on the row.

## Global invariants

**INV-30 (No credential value at rest in Valet).** No table, column, log, event, entry, report, or artifact holds a credential value or ciphertext. Postgres carries `op://` references only. A future column that would carry an encrypted or decrypted credential fails code review.

**INV-31 (Persona never sees the value).** The persona LLM's dispatch prompt, tool call args, tool results, and shell stdout never contain the plaintext value. Delivery to a shell command is via `valet-secrets run --env NAME=op://... -- cmd`; the child holds the env var, the persona holds only the ref.

**INV-32 (Broker allowlist).** `POST /api/sandbox-secrets/resolve` refuses every reference not in the calling session's owning security engagement's declared list (`security_engagements.credentials_json[*].ref`). A prompt-injected persona that asks for `op://Personal/wallet/seed` gets a 403 with a corrective error naming the closest declared label.

**INV-33 (Preflight refuses a bad engagement).** `startEngagement` runs the preflight pass. When any declared ref fails to resolve or fails the kind's shape check, the engagement stays in `planning`; the create route returns a corrective error naming the label, the ref, and the shape failure. No cell dispatches.

**INV-34 (Cred-typed need never carries the value).** `security_needs.resolution` stays NULL for a cred-typed need. The value never rides in the resolution column, in a request body, or in a WS answer frame. The needs panel accepts only `{label, kind, ref}`. A regression that writes plaintext to `resolution` is caught by the CHECK constraint (INV-14 belt from Part 10 survives here).

**INV-35 (Reference is not a value).** Storing, logging, or emitting an `op://` reference is safe. A reference alone does not authorize resolution; the broker still enforces the sandbox token, the session's token scope, and the allowlist. So the reference can appear in logs, in the dispatch prompt, and on the wire without redaction.

## Credential shape and delivery

The seven `kind` values from Part 10 survive; each maps to a persona-side usage pattern the dispatch prompt spells out. The `ref` for each kind resolves to a single 1Password field's value (a string). For multi-field bundles (Turnkey X-Stamp: pubkey + privkey + orgId + userId), declare either one credential per field with related labels, or one `toolAuth` credential whose `refShape: json` says the field value is JSON that the persona jq-parses.

| kind | Ref value | Persona usage |
|---|---|---|
| `password` | password bytes (login URL + username live in `meta`) | Persona POSTs login URL with `-d "user=<username>&pass=$PASSWORD"` via valet-secrets |
| `session` | Netscape cookie jar bytes | Persona feeds `-b -` from `$COOKIES_JAR` into curl |
| `headerToken` | token bytes | Persona sends `Authorization: <scheme> $TOKEN` |
| `mtls` | private key PEM (cert PEM in `meta.certPem` or a separate ref via `meta.certRef`) | Persona configures curl with `--cert`/`--key` from env-material |
| `signingKey` | private key PEM or hex bytes (algo in `meta.algo`, keyId in `meta.keyId`) | Persona signs a request body with `$SIGNING_KEY` |
| `toolAuth` | opaque blob (`meta.tool` names the consumer, `meta.format` in {json, raw}) | Persona parses `$TOOL_AUTH` (jq if json) and uses fields |
| `testData` | opaque value (label + scope in `meta`) | Persona sends `$TEST_DATA` as request body |

The dispatch prompt renders each credential as:

```md
Available credentials (resolve via `valet-secrets` at run-time; the value is only in the shell child's env):
- login   (kind=password,    ref=op://Security/example-login/password;  usage: POST username+password to https://example.com/login)
- admin   (kind=headerToken, ref=op://Security/admin/api-token;         usage: Authorization: Bearer $ADMIN)
- signer  (kind=signingKey,  ref=op://Security/turnkey-preprod/priv;    usage: sign X-Stamp with $SIGNER)

Example: `valet-secrets run --env ADMIN=op://Security/admin/api-token -- curl -H "Authorization: Bearer $ADMIN" https://api.example.com/v1/users`

The value is in the child's env, not in this turn's transcript. Do not print $ADMIN. Do not stash it in a tool arg. If the target rejects, raise a `credential` need naming the label; the human replaces the ref.
```

## Config schema

`SecurityConfig.credentials` (extended from Part 10):

```yaml
credentials:
  - label: admin
    kind: headerToken
    ref: op://Security/admin-token/credential
    meta:
      host: api.example.com
      scheme: Bearer
  - label: turnkey-preprod
    kind: toolAuth
    ref: op://Security/turnkey-preprod/bundle
    refShape: json         # the 1P field body is JSON; persona jq-parses env value
    meta:
      tool: turnkey-x-stamp
      format: json
```

Rules:

- `label` is unique per engagement; 1..128 chars; `A-Za-z0-9_.-`.
- `kind` is one of the seven values.
- `ref` MUST match `^op://[^/]+/[^/]+/[^/]+(/[^/]+)?$` (matches the broker's regex).
- `refShape` defaults to `raw`; `json` is an assertion the resolved value parses as JSON.
- `meta` is opaque per-kind sidecar (host, algo, scheme, tool, format, role, keyId, certRef, ...).
- The old Part 10 `env: NAME` form is refused at parse: replaced by `ref: op://...`.

Persisted on `security_engagements.credentials_json` as the array literal above.

## Preflight validation

At `startEngagement` (Part 01), after workspace clone and before `createCells`:

1. Load `engagement.credentials_json`. If empty, skip.
2. For each entry, resolve `ref` via `OnePasswordService.resolveReference` using the engagement's owning session's token scope (user session → `["org", "personal"]`; team/org session → `["org"]`).
3. Shape check by `kind`:
    - `password`: value length ≥ 1 (allow any bytes).
    - `session`: value contains at least one line matching the Netscape cookie format (`\thostOnly\tpath\tsecure\texpiry\tname\tvalue`).
    - `headerToken`: value length ≥ 8; if `meta.scheme === "Bearer"` and `meta.assertJwt`, then decode the JWT header and refuse on parse error.
    - `mtls`: value contains `-----BEGIN (RSA |EC )?PRIVATE KEY-----`; if `meta.certRef` is present, resolve and check the cert has `-----BEGIN CERTIFICATE-----`.
    - `signingKey`: value contains `-----BEGIN ` OR matches `^[0-9a-fA-F]{32,}$` (hex bytes).
    - `toolAuth`: if `refShape === "json"`, `JSON.parse` succeeds; otherwise value length ≥ 1.
    - `testData`: value length ≥ 1.
4. Zero every buffer used in the check (`Buffer.fill(0)` in `finally`).
5. On failure: throw `SecurityCredentialPreflightError` with `label`, `ref`, and `reason`. The start route returns 400 with a corrective error. The engagement stays `planning`.

The preflight NEVER hits the target. A 401 at run-time is a run-time surprise, not a config failure; the persona surfaces it as a fresh needs_human.

## Broker allowlist enforcement

`POST /api/sandbox-secrets/resolve` (PR #421 route). Extend the handler:

1. From `c.var.sandbox`, look up the calling session's owning security engagement:
    - `securityCells.childSessionId = sandbox.sessionId` → `securityCells.engagementId`.
    - When no security cell claims the session, the caller is not a security persona child; fall through to the existing behavior (PR #421's resolution as-is).
2. When a security cell is found, load `engagement.credentials_json`.
3. For each requested reference, check `references[i] IN credentials_json[*].ref`. Any miss short-circuits the response with 403 and a corrective error naming the closest-declared label (Levenshtein against declared refs) or `no credentials declared`.
4. On pass, proceed with PR #421's resolution.

The check is O(refs × declared) which is bounded (declared ≤ 8 typical, refs ≤ 25 per PR #421's cap).

## Needs routing

`security_needs.kind = "credential"` semantics change from Part 10:

- The needs panel widget renders three inputs: `label`, `kind`, `ref`. NO value input.
- `POST /security/needs/resolve` with a cred-typed need accepts `credentialRef: { label, kind, ref, refShape?, meta? }`.
- The handler:
  1. Preflight-resolves the ref (INV-33).
  2. Appends `{label, kind, ref, refShape?, meta?}` to `engagement.credentials_json`.
  3. Sets `security_needs.credential_ref = ref` (new column), keeps `resolution` NULL.
  4. Resets the cell to pending (existing Part 09 behavior).
- Rejects a cred-typed need with `resolution` (INV-34).
- The CHECK constraint from Part 10's INV-14 belt survives here: `kind = 'credential' → resolution IS NULL`.

## Wire API

Changes vs. Part 10:

Removed (were Part 10 vault routes):
- `POST /api/sessions/security/vault`
- `POST /api/sessions/:id/security/vault`
- `GET /api/sessions/:id/security/vault`
- `DELETE /api/sessions/:id/security/vault/:credentialId`
- `GET /api/sessions/:id/security/vault/:credentialId/access`

Kept and modified:
- `POST /api/sessions/:id/security/needs/resolve` accepts `credentialRef` (was `credentialInput` in Part 10 which carried a value; now only carries the ref).

Extended broker route (was PR #421):
- `POST /api/sandbox-secrets/resolve` gains the allowlist check for sessions owned by a security cell.

New:
- `GET /api/sessions/:id/security/credentials` returns `[{label, kind, ref, refShape?, meta?}]` for the engagement. Owner + session admins can read (refs are not secrets; INV-35).

## What Part 10 items get removed

- `engagement_credentials` table.
- `engagement_credential_access` table.
- `security_incidents` table (was for tripwire hits; no tripwire → no writers).
- `EngagementVault` service (`packages/api/src/services/security-vault.ts`); entire file.
- `security-vault-sweep.ts` and the wiring in `main.ts`.
- Vault OTel counters (`valet.security.vault.materialized`, `.tripwire.hits`, `.shred`, `.written`).
- `credsMount` write of vault values in `EngineHost.mintVaultCreds`; the method is deleted.
- Tripwire wiring on the send seam (`packages/api/src/engine/tripwire.ts` + call in `ws.ts`).
- Tripwire wiring on the persist seam (`packages/api/src/engine/persist-tripwire.ts` + call in `EngineHost.buildChildSession`).
- The `beforeEntryPersist` engine hook in `@valet/engine` stays as a general seam; the security-engagement caller is removed.
- Wizard "Vault" step + per-variant widgets + `VaultStep` component.
- Web hooks `useSecurityVault`, `useWriteSecurityVault`, `useDeleteSecurityVaultCredential`.
- Vault-related fields on wire types.
- Config seed's env-var resolution branch (replaced by `ref` resolution at preflight, not at seed).

Kept:
- The seven `kind` values + their file/env-var projection semantics.
- The dispatch prompt's per-credential rendering (now names the ref + env var, not a mount path).
- Config-parse extension in `packages/plugin-security/src/lib/config.ts`; the block's shape changes but the parser survives.
- `SecurityConfig.credentials` on the plugin type; field `env` renamed to `ref`.
- Needs kind `credential`; the routing branch keeps the CHECK constraint belt.

## Non-goals

- **Cross-engagement credential sharing.** Two engagements sharing a Turnkey key still declare the same `ref` in both YAMLs. 1Password is the shared store; Valet doesn't reference-share.
- **Live-target validation at preflight.** Preflight checks the shape, never the target. A dead token surfaces at run-time as a `needs_human`.
- **In-browser vault picker.** The wizard step accepts a pasted `op://` ref. Listing the user's 1Password vaults from the browser is a future ergonomic pass, gated on the 1P web integration.
- **Value-echo redaction.** Under the redesign the persona doesn't hold the value, so a tripwire on the transcript has no source. If a future feature reintroduces file-mounted values, the tripwire must return.

## Implementation checklist

Not implemented by this spec; the checklist drives the follow-up PR.

1. **Schema.** Add `security_engagements.credentials_json TEXT` (JSON array literal). Add `security_needs.credential_ref TEXT`. Add the CHECK constraint `security_needs.resolution IS NULL WHEN kind = 'credential'`. Drop `engagement_credentials`, `engagement_credential_access`, `security_incidents`. Update Drizzle schema + SCHEMA_REPAIRS.
2. **Delete vault.** Delete `packages/api/src/services/security-vault.ts`, `packages/api/src/services/vault-sweep.ts`, `packages/api/src/engine/persist-tripwire.ts`, `packages/api/src/engine/tripwire.ts`, and every callsite. Wire mkSandboxMint back to the pre-Part-10 shape.
3. **Config parse.** Extend `parseSecurityConfig` in `packages/plugin-security/src/lib/config.ts`: field is `ref`, not `env`; add `refShape?: "raw" | "json"`.
4. **Seed.** Extend `SeededSecurityReview.credentials` to the new shape; the session-create route writes the JSON literal into `security_engagements.credentials_json`.
5. **Preflight.** New `packages/api/src/services/security-credential-preflight.ts`; call from `startEngagement`. Buffer-only + `finally` zero. Emit `SecurityCredentialPreflightError` with corrective wording.
6. **Broker allowlist.** Extend `packages/api/src/routes/sandbox-secrets.ts` handler: look up owning security cell → engagement → `credentials_json`; check every requested ref against the declared set; 403 on any miss.
7. **Needs routing.** Rewrite the cred-typed branch in `resolveEngagementNeeds`: accept `credentialRef`, refuse plaintext `resolution`, preflight the ref, append to `credentials_json`, stamp `security_needs.credential_ref`.
8. **Dispatch prompt.** Replace the Part 10 file-path renderer with the ref+env-var renderer named in §Credential shape.
9. **Wire routes.** Delete the six vault routes. Add `GET /security/credentials`. Extend `POST /security/needs/resolve` with `credentialRef`.
10. **Web.** Replace `VaultStep` with a lightweight `CredentialsStep` that accepts pasted `op://` refs. Rewrite the needs cred widget to accept `{label, kind, ref}`, no value input. Delete `useSecurityVault` / `useWriteSecurityVault` / `useDeleteSecurityVaultCredential`.
11. **Preset flip.** `code-review` and source-only presets don't seed credentials; `code-audit-plus-live` and `live-pentest` presets show the Credentials step with empty rows.
12. **Docs.** Point Part 10's checklist to Part 12; add a "superseded by Part 12" banner at the top of Part 10.

Every step above closes at least one INV; every INV has at least one step.
