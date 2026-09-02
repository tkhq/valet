# Part 12: Security Engagement Credentials via 1Password

*Depends on: Part 00, Part 01, Part 04, Part 05, Part 09, Part 11. Also depends on `docs/specs/2026-07-21-onepassword-credentials-design.md` (PR #421) and the sandbox secret broker runtime (PR #421). Conformance: L1+ (config, preflight, broker allowlist); L3 pulls in the delivery path.*

## Purpose

Part 10 kept credentials in Postgres as ciphertext. It solved the plaintext leak on the flat needs-answer path, but it kept three problems: (a) a copy of every value lived in Valet, so teams already storing secrets in 1Password had to copy and rotate twice; (b) the persona sandbox mounted the plaintext as a file the agent could `cat`, so a prompt-injected persona could echo the value into a tool call or a message; (c) Valet's DB is now a target for a credential dump.

Part 12 removes the vault and consumes PR #421's 1Password + sandbox-secret-broker plumbing.

- Secrets stay in 1Password. Valet holds only the `op://vault/item/field` reference.
- The persona child sandbox NEVER mounts the value as a file. `valet-secrets run --env NAME=op://... -- cmd` runs one shell child with the value in its env for the duration of one command.
- The api-side broker rejects any resolve for a ref the engagement did not declare.
- Kind is explicit in the YAML and drives the shape check + the persona's usage hint.
- A prompt-injected persona CAN still echo the env var into the shell's stdout, which flows back as a tool result. The persist- and send-seam tripwire is the enforcement (see §Tripwire); the dispatch prompt tells the persona not to echo but that guidance is not the safety net.

Part 10's `engagement_credentials` table, `EngagementVault`, vault wizard step, and vault wire routes are removed by this part. Part 10's kind schema, dispatch-prompt rendering pattern, `security_incidents` table, and the `beforeEntryPersist` engine hook survive; the tripwire's index source rewires from local ciphertext decrypts to broker resolutions.

## Vocabulary

**op:// reference.** A 1Password locator of the form `op://<vault>/<item>/<field>[/<subfield>]`. The value is dereferenced at USE time via `OnePasswordService.resolveReference`. Nothing about the value is persisted; the reference is safe to store, log, and check into git.

**Engagement credentials.** A per-engagement list of `{label, kind, ref, refShape?, meta?}` declared in `.valet/security.yml` or added mid-run via the needs panel. Persisted as `security_engagements.credentials_json`. Ephemeral: dies with the engagement.

**Broker.** The sandbox-authenticated `POST /api/sandbox-secrets/resolve` route from PR #421. Called by the in-sandbox `valet-secrets` shell script. Returns base64-encoded values in a positional array.

**Broker allowlist.** The set of refs the engagement declared. The broker rejects any resolve request whose ref is outside the calling session's engagement allowlist.

**Preflight.** A validation pass at engagement start. Resolves each declared ref once, shape-checks by `kind`, drops the value. On failure the engagement refuses to start with a corrective error naming the label and the shape problem.

**Cred-typed need.** A `security_needs` row whose `kind` is `credential`. The resolve path appends `{label, kind, ref}` to `engagement.credentials_json`; the needs row stores `resolution = null` and `credential_ref = op://...`. There is no plaintext value on the row.

## Global invariants

**INV-30 (No credential value at rest in Valet).** No table, column, log, event, entry, report, or artifact holds a credential value or ciphertext. Postgres carries `op://` references only. A future column that would carry an encrypted or decrypted credential fails code review. Every error thrown during preflight, resolution, or broker dispatch MUST NOT include any byte of the resolved value; the catch block around `OnePasswordService.resolveReference` strips the upstream error message and substitutes a generic "1Password resolution failed for label <label>" reason.

**INV-31 (Persona MAY glimpse the value; tripwire is the safety net).** The dispatch prompt tells the persona not to echo the value. That is guidance, not enforcement. A prompt-injected persona can run `valet-secrets run --env ADMIN=op://... -- bash -c 'echo $ADMIN'`; the child's stdout flows back as a tool result and lands in `engine_entries.parts` and on the WS bus. INV-36 is the enforcement: the tripwire scans every persist and every send against the per-session broker-resolved value index and redacts hits in place.

**INV-32 (Broker allowlist; check before resolution).** `POST /api/sandbox-secrets/resolve` refuses every reference not in the calling session's owning security engagement's declared list (`security_engagements.credentials_json[*].ref`). A prompt-injected persona that asks for `op://Personal/wallet/seed` gets a 403 with a corrective error naming the closest declared label. The allowlist check MUST execute BEFORE any call to `OnePasswordService.resolveReference`; a ref that fails the allowlist MUST NOT trigger a 1Password API call. An implementer who reorders the check to "resolve then reject with a better error" leaks the value into api memory before the rejection.

**INV-33 (Preflight refuses a bad engagement; point-in-time snapshot).** `startEngagement` runs the preflight pass. When any declared ref fails to resolve OR fails the kind's shape check, the engagement stays in `planning`; the create route returns a corrective error naming the label, the ref, and the shape failure. No cell dispatches. Two failure modes are named distinctly: (a) `reason: "resolution_failed"` (`OnePasswordService.resolveReference` threw; the upstream message is scrubbed of value bytes and substituted); (b) `reason: "shape_failed"` (the value resolved but the kind's shape check refused it). The preflight validates a point-in-time snapshot; a value rotated in 1Password between preflight and cell dispatch may fail runtime with no preflight warning, and the persona surfaces it as a fresh needs_human.

**INV-34 (Cred-typed need never carries the value; CHECK deferred, service-layer guard active).** `security_needs.resolution` stays NULL for a cred-typed need. The value never rides in the resolution column, in a request body, or in a WS answer frame. The needs panel accepts only `{label, kind, ref}`. Service-layer refuses cred-typed writes to `resolution` today; a Postgres CHECK constraint (`kind = 'credential' → resolution IS NULL`) is deferred to 1.0's numbered migrations and lands as belt defense against a direct SQL bypass. Until then, the service layer is the sole gate.

**INV-35 (Reference is not a value).** Storing, logging, or emitting an `op://` reference is safe. A reference alone does not authorize resolution; the broker still enforces the sandbox token, the session's token scope, and the allowlist. So the reference can appear in logs, in the dispatch prompt, and on the wire without redaction.

**INV-36 (Tripwire on persist and send seams).** Every broker resolution for a session owned by a security cell registers the resolved value in a per-engagement fingerprint index. Two seams scan against the index:
- **Persist seam.** `beforeEntryPersist` hook on the persona child session's `Thread` (from `@valet/engine`); scans every entry before it lands in `engine_entries`.
- **Send seam.** WS-frame scan in `ws.ts`; scans every draft before delivery to the client.

A hit redacts in place to `[REDACTED cred:<label>]` and enqueues a `security_incidents` row. The index entries live for the session's lifetime; on session close, every match Buffer is zeroed. INV-36 accepts that the api process holds resolved values in memory for the session's lifetime AS A BYPRODUCT of the broker's existing role. This is a bounded surface: no ciphertext at rest, no cross-session sharing, no log lines, no persist of the raw bytes.

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

- `label` is unique per engagement AND MUST match `^[A-Za-z0-9_.-]{1,128}$`. `parseSecurityConfig` enforces the regex. The label becomes an env var name via `valet-secrets run --env <label>=op://...`, so a space or a shell metacharacter would break the invocation and could enable injection.
- `kind` is one of the seven values.
- `ref` MUST match `^op://[^/]+/[^/]+/[^/]+(/[^/]+)?$` (matches the broker's regex).
- `refShape` defaults to `raw`; `json` is an assertion the resolved value parses as JSON.
- `meta` is opaque per-kind sidecar (host, algo, scheme, tool, format, role, keyId, certRef, ...).
- The old Part 10 `env: NAME` form is refused at parse: replaced by `ref: op://...`.

Persisted on `security_engagements.credentials_json` as the array literal above.

Personal-vault caveat: refs to personal 1Password vaults resolve ONLY for user-owned sessions (PR #421 §Token scopes). A team- or org-owned engagement whose YAML lists a personal-vault ref fails preflight with `reason: "resolution_failed"` and a corrective error naming the scope mismatch. Move the ref to an org vault or run the engagement from your own workspace.

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
5. On failure: throw `SecurityCredentialPreflightError` with `label`, `ref`, and one of two `reason` variants: (a) `"resolution_failed"` when `OnePasswordService.resolveReference` threw (1Password down, ref not found, token scope wrong); (b) `"shape_failed"` when the value resolved but the kind's shape check refused it. The start route returns 400 with a corrective error. The engagement stays `planning`.
6. On EVERY error path, the `reason` string MUST NOT contain any byte of the resolved value. The `resolveReference` catch block strips the upstream error message and substitutes a generic scoping hint (e.g. `"1Password resolution failed for label admin (ref=op://.../..., scope=[org])"`) that names only the label, the ref, and the token scope tried. A shape-failed reason names the shape rule (`"headerToken value length is 3; minimum is 8"`) never the value bytes.

The preflight NEVER hits the target. A 401 at run-time is a run-time surprise, not a config failure; the persona surfaces it as a fresh needs_human. The preflight validates a point-in-time snapshot: a value rotated in 1Password between preflight and cell dispatch may pass preflight and fail at runtime with no early warning.

## Tripwire

INV-31's threat is real. The dispatch prompt tells the persona not to echo the value, but a prompt-injected persona can run `valet-secrets run --env ADMIN=op://... -- bash -c 'echo $ADMIN'`; the child's stdout flows back as a tool result and lands in `engine_entries.parts` and on the WS bus. The persona can also read the sandbox token from the creds mount, curl the broker directly with every declared ref, decode the base64 response, and echo the values into a tool result. Either channel puts the plaintext in the transcript.

The tripwire is the safety net.

### Index

Per-engagement `Map<label, matchBytes[]>` populated on every broker resolve for a session owned by a security cell. `matchBytes` carries the raw resolved value, its base64url encoding, and its URL-encoded form (so `Authorization: Bearer <token>` and `?tok=<url-encoded>` both match). Buffers are the sole heap copy; every entry lives for the session's lifetime and is zeroed with `.fill(0)` on session close.

The api process holds resolved values in memory for the session's lifetime. This is a bounded surface: no ciphertext at rest, no cross-session sharing, no log lines, no persist of the raw bytes. The values are already in api memory as a byproduct of PR #421's broker (the broker resolves the ref, base64-encodes it into the response, and its 5-minute cache holds the value); the tripwire extends the retention window to the session's lifetime so the scanner has something to check against.

### Persist seam

`beforeEntryPersist` hook on the persona child session's `Thread` (from `@valet/engine`). Runs before every entry hits `engine_entries` via `appendEntries` / `updateEntry`. Called for the four hot Thread.handleAgentEvent write sites (user-turn append, message_end assistant append, tool_execution_end update, turn_end update). On a hit, the entry's parts and content are rewritten in place to `[REDACTED cred:<label>]`, a `security_incidents` row is enqueued, and the redacted entry proceeds through the persist path. Fail-closed: a throwing hook drops the persist entirely so a broken scanner never lets raw bytes through.

### Send seam

WS-frame scan in `packages/api/src/routes/ws.ts`. Scans `tool_start.args`, `tool_end.result`, `message_update` parts+content, and `text_delta.delta` before each draft hits `send(ws, draft)`. Redaction and incident recording match the persist seam.

### Egress seam (accepted risk in v1)

The in-sandbox gateway does not filter stdout/stderr of a `valet-secrets` child before it crosses back to the api. A persona that echoes the value into a tool result carries plaintext across the sandbox-to-api boundary until the persist seam catches it. This window is short (one bus event) but it exists. Full in-sandbox redaction requires the `valet-secrets` script to wrap the child's stdout with a redactor keyed on the exact values it just injected; it is called out in the implementation checklist as a follow-up.

### Cleanup

- On session close (`EngineHost.destroy` or the child's terminal cell settlement), the engagement's index entries are zeroed and dropped.
- On engagement `cancelled`, every index entry for the engagement drops immediately.
- On broker cache eviction (5 minutes since the last resolve), the tripwire keeps its copy (the persona may still echo an older value the broker no longer caches). Freshness is not the tripwire's job; presence is.

### Metrics

- `valet.security.credentials.tripwire.hits{seam="persist"|"send"}` counter on every hit.
- `valet.security.credentials.tripwire.index_size` gauge on entry count per engagement.

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
- Vault-flavored tripwire wiring (`packages/api/src/engine/persist-tripwire.ts` fed by decrypted vault ciphertext, `packages/api/src/engine/tripwire.ts` fed by the same source). The scanner design survives (see §Tripwire above) but is rewired: the index is populated from broker resolutions, not from local ciphertext decrypts.
- Wizard "Vault" step + per-variant widgets + `VaultStep` component.
- Web hooks `useSecurityVault`, `useWriteSecurityVault`, `useDeleteSecurityVaultCredential`.
- Vault-related fields on wire types.
- Config seed's env-var resolution branch (replaced by `ref` resolution at preflight, not at seed).

Kept:
- The seven `kind` values + their file/env-var projection semantics.
- The dispatch prompt's per-credential rendering (now names the ref + env var, not a mount path).
- Config-parse extension in `packages/plugin-security/src/lib/config.ts`; the block's shape changes but the parser survives.
- `SecurityConfig.credentials` on the plugin type; field `env` renamed to `ref`.
- Needs kind `credential`; the routing branch keeps the CHECK constraint belt (service-layer guard active, CHECK deferred to 1.0).
- The tripwire's `beforeEntryPersist` hook in `@valet/engine`. §Tripwire above rewires the caller: the index now comes from broker resolutions, not local decrypts.
- The `security_incidents` table, for tripwire hit records.

## Non-goals

- **Cross-engagement credential sharing.** Two engagements sharing a Turnkey key still declare the same `ref` in both YAMLs. 1Password is the shared store; Valet doesn't reference-share.
- **Live-target validation at preflight.** Preflight checks the shape, never the target. A dead token surfaces at run-time as a `needs_human`.
- **In-browser vault picker.** The wizard step accepts a pasted `op://` ref. Listing the user's 1Password vaults from the browser is a future ergonomic pass, gated on the 1P web integration.
- **In-sandbox egress-seam redaction.** The persist and send seams catch value bytes that reach the api process. A `valet-secrets` child that echoes the value into a tool result carries plaintext across the sandbox-to-api boundary until the persist seam catches it. Full in-sandbox redaction (wrapping the child's stdout with a value-aware filter inside `valet-secrets`) is called out in the implementation checklist as a follow-up but is not required for v1.
- **Zero value memory in the api.** The api process holds resolved values in memory for the calling session's lifetime, as a byproduct of the broker's resolution and the tripwire's index. This is a bounded, documented residual risk under §Tripwire.

## Implementation checklist

Not implemented by this spec; the checklist drives the follow-up PR.

1. **Schema.** Add `security_engagements.credentials_json TEXT` (JSON array literal). Add `security_needs.credential_ref TEXT`. KEEP `security_incidents` (for tripwire hit records). Drop `engagement_credentials` and `engagement_credential_access`. Update Drizzle schema + SCHEMA_REPAIRS. Pre-1.0 dev clears the dropped tables with `make dev-clean`; a numbered 1.0 migration drops them in dependency order. The `kind='credential' → resolution IS NULL` CHECK constraint lands as a 1.0 migration; the service-layer refuse is the sole gate in the meantime.
2. **Delete vault.** Delete `packages/api/src/services/security-vault.ts` and `packages/api/src/services/vault-sweep.ts`. KEEP `packages/api/src/engine/persist-tripwire.ts` and `packages/api/src/engine/tripwire.ts`; rewire the index source (see step 5). Wire `mintSandboxMint` back to the pre-Part-10 shape (no vault materialize).
3. **Config parse.** Extend `parseSecurityConfig` in `packages/plugin-security/src/lib/config.ts`: field is `ref`, not `env`; add `refShape?: "raw" | "json"`; enforce label regex `^[A-Za-z0-9_.-]{1,128}$`.
4. **Seed.** Extend `SeededSecurityReview.credentials` to the new shape; the session-create route writes the JSON literal into `security_engagements.credentials_json`.
5. **Preflight.** New `packages/api/src/services/security-credential-preflight.ts`; call from `startEngagement`. Buffer-only + `finally` zero. Emit `SecurityCredentialPreflightError` with `reason: "resolution_failed" | "shape_failed"`. Scrub every upstream `resolveReference` error message of value bytes before rethrow.
6. **Broker allowlist + tripwire index population.** Extend `packages/api/src/routes/sandbox-secrets.ts` handler: look up owning security cell → engagement → `credentials_json`; check every requested ref against the declared set BEFORE any `resolveReference` call; 403 on any miss. On successful resolution, register each resolved value in the per-engagement tripwire index keyed by `<engagementId, label>`.
7. **Tripwire persist seam.** Wire `beforeEntryPersist` on the persona child's `Thread` (via `EngineHost.buildChildSession`). Scanner consults the per-engagement index; hits redact in place and enqueue a `security_incidents` row.
8. **Tripwire send seam.** Wire the WS-frame scan in `packages/api/src/routes/ws.ts` (same index).
9. **Tripwire lifecycle.** On session close, zero every match Buffer for the session's engagement and drop the index entries. On engagement `cancelled`, drop immediately.
10. **Needs routing.** Rewrite the cred-typed branch in `resolveEngagementNeeds`: accept `credentialRef`, refuse plaintext `resolution`, preflight the ref, append to `credentials_json`, stamp `security_needs.credential_ref`. The needs path relies on the session's token scope (not the broker allowlist yet, since the ref is not in the allowlist until appended) as its authorization gate; the human reviewer pastes the ref, so the human is the last-mile check.
11. **Dispatch prompt.** Replace the Part 10 file-path renderer with the ref+env-var renderer named in §Credential shape.
12. **Wire routes.** Delete the six vault routes. Add `GET /security/credentials`. Extend `POST /security/needs/resolve` with `credentialRef`.
13. **Web.** Replace `VaultStep` with a lightweight `CredentialsStep` that accepts pasted `op://` refs (client-side regex validation on the same pattern the parser uses); server is the real gate. Rewrite the needs cred widget to accept `{label, kind, ref}`, no value input. Delete `useSecurityVault` / `useWriteSecurityVault` / `useDeleteSecurityVaultCredential`.
14. **Preset flip.** `code-review` and source-only presets don't seed credentials; `code-audit-plus-live` and `live-pentest` presets show the Credentials step with empty rows.
15. **Docs.** Point Part 10's checklist to Part 12; add a "superseded by Part 12" banner at the top of Part 10.
16. **In-sandbox egress redactor (follow-up).** Extend `valet-secrets` to wrap child stdout/stderr with a value-aware filter keyed on the exact values it just injected. Closes the sandbox-to-api boundary window that the persist seam handles today. Not required for v1.

Every step above closes at least one INV; every INV has at least one step.
