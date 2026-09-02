# Part 10: Per-engagement credential vault

*Depends on: Part 00, Part 01, Part 04, Part 05, Part 06, Part 07, Part 09. Conformance: L1+ (server-side gates, redaction, and route behavior); L3 delivers cells to sandboxes.*

## Purpose

Live personas (dast, fuzz, exploit) and the pivot round need real credentials to reach the target: admin session cookies, PATs, bearer tokens, mTLS pairs, signing keys, cookie jars, test-account rows. Today the only channel for that material is the flat needs surface (M-P4c): the user pastes the value into `security_needs.resolution` as free text. That value is then:

1. Stored plaintext in Postgres.
2. Interpolated verbatim into the child dispatch prompt (`services/security-engagements.ts:589`).
3. Persisted into `engine_entries.parts` for the child session.
4. Reprojected on `/messages` and streamed live over the WS bus.
5. Re-rendered in the needs section of the UI to anyone with `view` on the session.
6. Reachable by the report cell, which can quote it back into `security_engagements.report_markdown` and the downloadable JSON.

No redactor covers any of those hops. Even a well-behaved persona chain leaks the value; a prompt-injection in the scanned repo owns it outright. That is the gap Part 10 closes.

The design goal is fluid ingress, zero visibility. Any credential form. Only the engagement owner ever sees the label. No one ever sees the value again after upload.

## Vocabulary

**Credential.** A single opaque secret the user provides for a review, plus a `label` and a `kind`. The `kind` is one of the seven variants below and drives how the sandbox receives it. The user assigns the label; personas reference credentials by label.

**Vault.** The per-engagement collection of credentials. Owned by the user who created the engagement, encrypted at rest, delivered to a running sandbox as files under `/etc/valet/creds/vault/`, and destroyed with the engagement.

**Fingerprint.** The SHA-256 of the credential value, truncated to 16 bytes and base64url-encoded. Used only by the tripwire (§Redaction) to detect a plaintext leak. Never returned by any route; never in logs.

**Materialize.** The dispatch-time step where the api decrypts a credential, writes it to `credsFiles` in the sandbox mount, and hands the sandbox a file path. Values live in RAM only for the duration of the mint.

**Tripwire.** A server-side scanner that inspects every engine event, entry write, and outbound WS frame for a byte substring matching a live credential value or one of its fingerprints. A hit hard-fails the cell, quarantines the entry, and raises a security incident.

**Cred-typed need.** A `security_needs` row whose `kind` is `credential`. The resolve path routes it into the vault; the `resolution` column stays NULL by CHECK constraint.

## Global invariants

**INV-12 (Value never enters shared state).** A credential value MUST NOT appear in `security_needs.resolution`, `engine_entries.content`, `engine_entries.parts`, `security_engagements.report_markdown`, `security_engagements.report_json`, `security_files.content`, WS frames (`tool_start`, `tool_end`, `entry`, `sandbox_status`, `init`), findings, coverage, or blobs. The tripwire is the enforcement seam; the structural design (§Ingress, §Dispatch) is the primary prevention.

**INV-13 (Values decrypt on demand only).** A credential is decrypted only inside `EngagementVault.materialize`, only for a cell that is transitioning to `running` on an engagement in `running` state, and only into a `credsMount` write. The plaintext is not held past the `writeSecret` call. No other code path holds a decrypt handle.

**INV-14 (Cred-typed need answers route through the vault).** The `resolveEngagementNeeds` handler routes a cred-typed need's value into `EngagementVault.writeCredential` before touching the need row. A Postgres CHECK constraint rejects any write to `security_needs.resolution` where `kind = 'credential'` and the answer is non-NULL. A future refactor that forgets to route hits the constraint, not the value column.

**INV-15 (Owner-only read, no admin peek).** Only `owner_user_id` can list credential labels or delete a credential. A session admin who is not the owner sees the vault size (a count) but no labels, no kinds, no metadata. Every read stamps an audit row in `engagement_credential_access` (§Audit).

**INV-16 (Environment-bound decryption).** Every ciphertext row stores `kek_id`. The api refuses to decrypt a row whose `kek_id` does not match the current environment's key id. A backup restored into staging with the prod `VALET_ENCRYPTION_KEY` still absent produces a hard error; a restore into a matching environment scrubs `ciphertext` at pipeline time (see §Operations).

**INV-17 (Crypto-shred on death).** On engagement `cancelled`, on manual purge, or on TTL expiry (default 14 days from `last_used_at`), every `engagement_credentials` row is DELETED. There is no soft delete. A row that is gone is gone.

## Credential shape

Seven variants cover every persona need surveyed in `personas/{dast,fuzz,exploit,pivot-coordinator}.md`. The union is intentionally minimal and extensible; new variants land as new `kind` values without touching the storage or delivery layers.

```ts
type Credential =
  | { kind: "password";     loginUrl: string; username: string; password: string; role?: string }
  | { kind: "session";      host: string; jarNetscape: string; role?: string; expiresAt?: string }
  | { kind: "headerToken";  host: string; scheme: "Bearer" | "ApiKey" | string; token: string }
  | { kind: "mtls";         host: string; certPem: string; keyPem: string }
  | { kind: "signingKey";   algo: "ecdsa" | "ed25519" | "hmac" | "rsa"; keyPem: string; keyId?: string }
  | { kind: "toolAuth";     tool: string; blob: string; format?: "json" | "raw" }
  | { kind: "testData";     label: string; value: string; scope?: string };
```

Non-value fields (`kind`, `host`, `algo`, `scheme`, `tool`, `format`, `role`, `expiresAt`) are stored alongside the label; they inform the persona how to use the credential. Value fields (`password`, `token`, `jarNetscape`, `certPem`, `keyPem`, `blob`) are collapsed into a single opaque body and stored only as ciphertext. The persona sees a file path plus the non-value fields; it never sees the value in its prompt.

## Schema

New table `engagement_credentials`:

```
id                  TEXT PRIMARY KEY               -- ec_<...>
engagement_id       TEXT NOT NULL REFERENCES security_engagements(id) ON DELETE CASCADE
owner_user_id       TEXT NOT NULL                  -- created the engagement; only reader
label               TEXT NOT NULL                  -- user-assigned; unique per engagement
kind                TEXT NOT NULL                  -- 'password' | 'session' | ... (§Credential shape)
meta_json           JSONB NOT NULL                 -- non-value fields (host, algo, ...)
ciphertext          BYTEA NOT NULL                 -- v1:{iv}:{tag}:{ct} via encryptSecret
kek_id              TEXT NOT NULL                  -- env-stamped
fingerprint         TEXT NOT NULL                  -- sha256(value)[0:16], base64url
created_at          BIGINT NOT NULL
last_used_at        BIGINT                         -- stamped on materialize
dead_at             BIGINT                         -- set when target rejects (401/403); never read again
expires_at          BIGINT                         -- optional per-cred TTL
UNIQUE (engagement_id, label)
```

New table `engagement_credential_access` (audit; no values, no fingerprints in this table):

```
id                  TEXT PRIMARY KEY               -- eca_<...>
credential_id       TEXT NOT NULL REFERENCES engagement_credentials(id) ON DELETE CASCADE
engagement_id       TEXT NOT NULL
cell_id             TEXT NOT NULL
sandbox_id          TEXT
dispatched_at       BIGINT NOT NULL
released_at         BIGINT                         -- stamped when the sandbox closes
```

Existing `security_needs` gains:

```
ALTER TABLE security_needs
  ADD COLUMN credential_id TEXT REFERENCES engagement_credentials(id) ON DELETE SET NULL,
  ADD CONSTRAINT security_needs_cred_no_resolution
    CHECK (kind <> 'credential' OR resolution IS NULL);
```

The CHECK is the safety net for INV-14. A schema-layer refuse costs one line and catches every forgotten routing hop.

## Ingress

Two entry paths, both funnel through one service call.

### At engagement start

The setup wizard grows a new step "Vault" between Focus and Launch (or folds into Launch for compact presets; the step is optional when no live persona is in the plan). The user adds N credentials with `label`, `kind`, and value. Each variant renders its own input widget:

- `password`: three text fields (`loginUrl`, `username`, `password`), `password` masked.
- `session`: file upload for the Netscape jar, plus optional `role` and `expiresAt`.
- `headerToken`: `host`, `scheme` dropdown, masked `token`.
- `mtls`: two file uploads (`certPem`, `keyPem`), `host`.
- `signingKey`: `algo` dropdown, file upload for `keyPem`, optional `keyId`.
- `toolAuth`: `tool` label, format dropdown, file upload or textarea for `blob` (masked).
- `testData`: `label`, single value textarea, optional `scope`.

Values live in React state only until submit. On submit, the client discards them. The client never persists them to `sessionStorage`, `localStorage`, or IndexedDB.

The client posts to `POST /api/sessions/security/vault` (pre-create) with the plaintext values. The server:

1. Derives the key via `deriveSecretKey(VALET_ENCRYPTION_KEY)` (existing).
2. For each credential, encrypts the value body via `encryptSecret` (existing), computes `fingerprint`, writes the row with `owner_user_id = session.userId` and `kek_id = <env>`.
3. Returns `[{id, label, kind}]`. No values. No fingerprints.

The wizard binds the returned `credentialIds` to the create request. On session create, the server transfers ownership: it re-writes `engagement_id` to the freshly minted engagement id in the same transaction that creates `security_engagements`. A vault created against a session that never materializes (user cancels the wizard) is garbage-collected after 1 hour.

### Late needs answer

For a cred-typed need surfaced during a run, the needs panel renders the SAME credential-input widget (`kind` is set by the persona that raised the need). The client submits `POST /api/sessions/:id/security/needs/resolve` with `{needId, credentialInput: {label, kind, value}}`. The server:

1. Writes the credential to the vault (`EngagementVault.writeCredential`).
2. Updates the need row with `credential_id`, leaves `resolution` NULL.
3. Runs the resume path from Part 09 (`reopenBeforeAnswer`) if the engagement is terminal.

The needs panel never renders a free-text textarea for a cred-typed need. The old textarea path stays wired for decision-typed and scope-typed needs only.

## Dispatch

`EngagementVault.materialize(engagementId, cellId, sandboxId)` runs once per cell dispatch, from `buildSandboxMint` (`packages/api/src/engine/host.ts:1236`). Steps:

1. Load every `engagement_credentials` row for the engagement where `dead_at IS NULL`.
2. Load the cell's persona; look up `persona_credential_expectations` (a static map in the plugin: which labels a persona expects, keyed by persona id). Only labels the persona expects are materialized; unmentioned labels stay unrevealed.
3. For each selected row: decrypt via `decryptSecret`, project into a file body per `kind`:
    - `password`: JSON `{loginUrl, username, password, role}`.
    - `session`: raw jar bytes.
    - `headerToken`: JSON `{host, scheme, token}`.
    - `mtls`: `credentials.cert.pem` + `credentials.key.pem` (two files).
    - `signingKey`: raw key pem.
    - `toolAuth`: the blob body, extension by `format`.
    - `testData`: JSON `{label, value, scope}`.
4. Handoff to `SandboxSecretsApi.writeSecret` (existing, `packages/sandbox-kubernetes/src/manifest.ts:178`, `packages/sandbox-docker/src/sandbox.ts:876`); base64 body, path `/etc/valet/creds/vault/<label>[.<ext>]`.
5. Stamp `last_used_at` and insert `engagement_credential_access` row.
6. Return `{ [label]: filePath }` to the caller, which the dispatch prompt receives.

The dispatch prompt then renders credentials as file references, never values:

```md
Available credentials (paths inside the sandbox):
- login (kind=password)   → /etc/valet/creds/vault/login
- admin (kind=headerToken) → /etc/valet/creds/vault/admin
```

The persona reads the file at run-time. The value never touches the prompt, never touches `engine_entries.parts`, never touches the wire.

## Redaction

The tripwire is the belt to the structural braces above. It runs at three seams:

1. **Persist**: `Thread.handleAgentEvent` (`packages/engine/src/thread.ts`) calls `tripwire.scanEntry(entry, credentialIndex)` before every `appendEntries`/`updateEntry`. A hit throws `CredentialLeakError` before the row hits the DB; the cell fails with a corrective error naming the credential label; the entry is quarantined into `security_incidents` (new table) with the value substring redacted.
2. **Send**: `engineToWireParts` (`packages/api/src/engine/bridge.ts:278,289`) calls `tripwire.scanFrame(frame, credentialIndex)` before every WS write. Same failure mode. This catches a tool-call arg the engine has not yet persisted.
3. **Egress**: The in-sandbox gateway (`packages/sandbox-gateway`) filters stdout and stderr through `redactBytes(credentialIndex)` before forwarding to the api. Even a persona that reads a value and prints it verbatim into `stdout` sees `[REDACTED cred:<label>]` on the wire.

`credentialIndex` is a per-engagement map `Map<fingerprint, {label, credentialId}>` plus a live-value cache used only during a dispatch window. The values are indexed by exact byte substring and by URL-safe-base64 encoding to catch `Authorization: Bearer <token>` and JSON-embedded variants. The index is loaded once per session's engine loop and updated on `writeCredential` / row delete.

A tripwire hit is a security incident, not a warning. The cell fails, the engagement pauses, the report cell refuses to run until the incident is reviewed. Retry is manual.

## Owner scope

Credential reads are scoped to the creating user, not the org.

- The engagement panel shows every viewer the vault size (`vault.count`) and NOTHING else.
- The vault section (labels, kinds, `dead_at`, `last_used_at`) is visible to `session.userId === owner_user_id` ONLY. A non-owner sees "N credentials in the vault; owner: <user handle>".
- The Delete action is owner-only. A session admin who is not the owner cannot delete a credential; the admin can only cancel the engagement, which crypto-shreds the vault.
- On engagement transfer (not in v1), the vault does NOT transfer. The new owner sees zero credentials and must upload their own.

## Wire API

Endpoints (all under `/api/sessions`; owner-only unless noted).

```
POST   /security/vault
  → body: { credentials: [{label, kind, value, meta?}] }
  → returns: { credentialIds: [{id, label, kind}] }
  Ephemeral pre-create vault. Bound to a session on the next create.

POST   /:id/security/vault
  → body: same shape
  → returns: same shape
  Post-create add.

GET    /:id/security/vault
  → returns:
      owner: { userId, handle }
      count: number
      credentials?: [{id, label, kind, meta, createdAt, lastUsedAt, deadAt}]  // owner only

DELETE /:id/security/vault/:credentialId
  → 204 on success; DELETE row; access-log stays.

POST   /:id/security/needs/resolve  (extended)
  → body: { needId, credentialInput?: {label, kind, value}, resolution?: string, dismiss?: boolean }
  Cred-typed needs REQUIRE `credentialInput`; a `resolution` on a cred-typed need is a 400.
  Non-cred needs keep the existing `resolution` path.
```

Every route rejects when `session.userId !== owner_user_id` for owner-scoped operations, with the corrective error naming the owner handle.

## Audit

Every materialize writes an `engagement_credential_access` row with `credential_id`, `engagement_id`, `cell_id`, `sandbox_id`, `dispatched_at`. When the sandbox closes, the reconcile sweep stamps `released_at`. The owner can view an access log for each credential:

```
GET /:id/security/vault/:credentialId/access
  → owner-only; returns access rows oldest-first
```

The access log is the answer to "who used my token, and when, and for what cell". It contains no value and no fingerprint.

A tripwire hit writes `security_incidents` (new table): `{id, engagement_id, cell_id, credential_id, seam: "persist"|"send"|"egress", detected_at, quarantined_entry_id?}`. No value substring is stored; only the label and the seam.

## Config schema extensions

`SecurityConfig` gains one field:

```yaml
credentials:
  # A vault built from a repo's `.valet/security.yml` at engagement create.
  # Values are read from environment variables at load time; the YAML never
  # holds the plaintext. `env` names the env var the api reads at seed time.
  - label: admin
    kind: headerToken
    host: api.example.com
    scheme: Bearer
    env: EXAMPLE_ADMIN_TOKEN
  - label: user-session
    kind: session
    host: app.example.com
    env: EXAMPLE_USER_JAR
```

The plugin's config loader reads `env` names, resolves against `process.env`, and hands the values to the vault seed step during create. The plaintext never appears in the YAML on disk; a checked-in `.valet/security.yml` is safe.

An engagement created from this config carries the labels the config named; the wizard's Vault step shows them as prefilled shells the user can confirm or overwrite.

## Operations

**Key rotation.** `VALET_ENCRYPTION_KEY` rotation is a two-phase job:

1. Deploy the new key with the old key still accepted (via a `VALET_ENCRYPTION_KEY_PREV` env). Re-encrypt every row: `SELECT id FROM engagement_credentials`; for each row, decrypt with the row's `kek_id`, encrypt with the new key, stamp new `kek_id`.
2. Drop `VALET_ENCRYPTION_KEY_PREV`.

Failed decrypts during phase 1 log a warning and skip the row; the credential shows as `dead` in the vault view with reason "key rotation".

**Backup restore.** The backup pipeline MUST scrub `engagement_credentials.ciphertext` and `security_needs.credential_id` before any non-prod restore. The pipeline calls `UPDATE engagement_credentials SET ciphertext = NULL, dead_at = <now> WHERE ciphertext IS NOT NULL` then `UPDATE security_needs SET credential_id = NULL WHERE credential_id IS NOT NULL`, in that order. The api refuses to boot against a restored DB whose `kek_id` values do not match the current env's key id; the pipeline scrub is the only remediation.

**TTL sweep.** A background job runs once an hour: `DELETE FROM engagement_credentials WHERE last_used_at < now() - 14 days OR expires_at < now()`. The default 14-day TTL is overridable per row via `expires_at`. The report cell sees the crypto-shred as `dead_at` set with reason "TTL"; a resumed cell that expected a shredded credential surfaces a fresh `credential` need.

**Metrics.** New counters (Prometheus):

- `valet_vault_materialized_total{engagement_id, credential_kind}` on every dispatch.
- `valet_vault_tripwire_hit_total{seam, credential_kind}` on every hit.
- `valet_vault_shred_total{reason}` on TTL, cancel, or manual purge.
- `valet_vault_ciphertext_bytes` gauge for capacity planning.

No metric includes labels or values.

## Migration

Pre-1.0 rule from the root CLAUDE.md: edit `0000_engine.sql` and `0000_app.sql` in place. New tables and the CHECK constraint land in the same edit. Every worktree with dev data must run `make dev-clean`.

The dispatch prompt change (`buildDispatchPrompt` at `services/security-engagements.ts:589`) is a straight code edit: cred-typed answers become `via /etc/valet/creds/vault/<label>` (the path), never `→ <value>`.

## Non-goals

- **Multi-user credential sharing.** A vault is owned by one user. Sharing lands only if a real workflow demands it.
- **KMS / HSM integration.** The `kek_id` column is KMS-ready; v1 uses `VALET_ENCRYPTION_KEY`. A future version swaps the key source.
- **OAuth flows.** The vault stores static values. Automatic refresh lands as a future variant using the `OAuthRefreshingCredentialStore` pattern.
- **Per-cell scoping override.** The persona-credential expectations map is static per persona id. A run that wants to hand a persona a credential outside its map has to add the label to the map (in the plugin), not paper over it in the vault.
- **In-place secret editing.** A credential is create-and-delete. To change a value, the user creates a new label and deletes the old.

## Implementation checklist

The checklist drives the shipping PRs. Each item names its status so a
reader can trace what is live vs what is next.

1. **Shipped.** Schema: `engagement_credentials`, `engagement_credential_access`, `security_incidents`, `security_needs.credential_id`. SCHEMA_REPAIRS entries for every table + column + index. The CHECK constraint on `security_needs.resolution` is deferred to 1.0 numbered migrations; the service layer refuses cred-typed writes to `resolution` in the meantime.
2. **Shipped.** Service: `EngagementVault` composing `secret-crypto.ts` + PgCredentialStore pattern + owner-scoped ACL. Adds `decryptSecretBuffer` / `encryptSecretBuffer` / `deriveKekId` so the service reads plaintext into a Buffer, zeros it in `finally`, and env-stamps every row (INV-16).
3. **Shipped.** Dispatch wiring: `EngineHost.mintVaultCreds` → `credsMount` files at `/etc/valet/creds/vault-<label>.<ext>`. `buildDispatchPrompt` renders the file path for cred-typed answers; falls back to the raw resolution when the row has no `credential_id` so pre-vault callers keep working.
4. **Shipped (send + persist seams).** Tripwire on the WS send seam (`scanAndRedactWireEvent` in `packages/api/src/engine/tripwire.ts`, wired in `routes/ws.ts`) and on the engine persist seam (`beforeEntryPersist` hook on `CreateSessionOptions`; `buildPersistTripwire` in `packages/api/src/engine/persist-tripwire.ts`; wired at `EngineHost.buildChildSession`). The engine's in-sandbox gateway egress redactor is deferred as a hardening pass; the persist + send seams close every path that leaves the api process.
5. **Shipped.** Routes: `POST /:id/security/vault`, `GET /:id/security/vault`, `DELETE /:id/security/vault/:credentialId`, `GET /:id/security/vault/:credentialId/access`, and `POST /:id/security/needs/resolve` extended with `credentialInput`.
6. **Shipped.** Wizard step and UI: a "Vault" step between Plan and Launch (`packages/web/src/components/security/vault-step.tsx`), needs-panel cred widget (`packages/web/src/components/security/needs-section.tsx`), and mutation hooks `useSecurityVault`/`useWriteSecurityVault`/`useDeleteSecurityVaultCredential`. Values live in React state only until submit; the wizard discards them from state after the vault write lands.
7. **Shipped.** Config seed: `credentials:` block parsed by `parseSecurityConfig`; the create route reads each `env` name from `process.env` and writes to the engagement's vault as its owner. A missing env logs a warning and skips (the persona surfaces a fresh need); a duplicate label also warns and skips.
8. **Shipped.** Ops: TTL sweep (`startVaultSweep` in `packages/api/src/services/vault-sweep.ts`), four OTel counters (`valet.security.vault.materialized`, `valet.security.vault.tripwire.hits`, `valet.security.vault.shred`, `valet.security.vault.written`), and the `EngagementVault.purgeEngagement` handle. Backup-scrub hook is a documented pipeline step, not a code change; key-rotation script is a runbook step for when staging/prod exist.
9. **Deferred.** Backfill: cred-typed `security_needs` rows with non-NULL `resolution` on pre-Part-10 databases. Pre-1.0 dev databases run `make dev-clean`; a real backfill lands when staging/prod exist.
10. **Shipped in this spec.** Docs: this checklist. A contributor runbook and Launch checklist copy update land in the next PR whose scope touches user-facing docs.

Every step above closes at least one threat scenario; every closed scenario has a step above.
