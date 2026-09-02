# Adversarial review: Part 10 (per-engagement credential vault)

Reviewer: automated design review against the spec's own invariants, the threat model, the implementation diff (PR #497), and PR #421 (1Password credential backend).

## Against its own invariants

### INV-12 (Value never enters shared state)

**Spec claim.** A credential value MUST NOT appear in `security_needs.resolution`, `engine_entries.content`, `engine_entries.parts`, WS frames, findings, coverage, or blobs. The tripwire is the enforcement seam.

**Gap: `needle.length < 8` skip in the tripwire scanner.**

Both `packages/api/src/engine/tripwire.ts` and `packages/api/src/engine/persist-tripwire.ts` contain this guard:

```ts
if (needle.length < 8) continue;
```

Any credential whose raw value, base64url encoding, *and* percent-encoded form are all shorter than 8 bytes bypasses the scanner entirely. Concrete examples:

- A 5-character API key (e.g. `ab12X`).
- A short test password (e.g. `pass1`).
- A 4-byte HMAC key.

The spec does not acknowledge this threshold. INV-12 says the tripwire is the enforcement seam, but for short credentials the tripwire is absent. The structural prevention (never injecting values into prompts) is the only protection.

**Severity: medium.** Short credentials are uncommon in production security reviews, but the spec should either document the threshold or remove the skip for credential-index scans (at the cost of more false positives on short substrings).

**Recommendation.** Add a note to Part 10 §Redaction: "The scanner skips match substrings shorter than 8 bytes to avoid false positives on common short strings. Credentials shorter than 8 characters rely on structural prevention only (§Ingress, §Dispatch). Implementations that accept short credentials SHOULD log a warning at write time."

### INV-13 (Values decrypt only inside `EngagementVault.materialize`)

**Spec claim.** A credential is decrypted only inside `EngagementVault.materialize`, only for a cell that is transitioning to `running`.

**Finding: `tripwireIndex` also calls `decryptSecretBuffer`.**

`security-vault.ts:539` calls `decryptSecretBuffer` inside the `tripwireIndex` method to build the match-byte index. This is a second decryption code path outside `materialize`. The decrypted bytes are held in `matchBytes` buffers for the duration of a dispatch window (or longer, for the persist-seam hook that caches its index for the child session's entire lifetime).

**Severity: medium.** The invariant text says "No other code path holds a decrypt handle." This is false. The tripwire index holds decrypted values (as Buffers, not strings) for scanning. The `dispose()` handle zeros them, but the window is wider than `materialize`'s scope.

**Recommendation.** Amend INV-13 to read: "A credential is decrypted only inside `EngagementVault.materialize` (for sandbox file writes) and `EngagementVault.tripwireIndex` (for scan-time substring matching). No other code path holds a decrypt handle. Both code paths zero the plaintext buffer via `dispose()` when their scope closes."

### INV-14 (Cred-typed need answers route through the vault)

**Spec claim.** A Postgres CHECK constraint rejects any write to `security_needs.resolution` where `kind = 'credential'` and the answer is non-NULL. The constraint is the safety net.

**Contradiction: the implementation checklist says the CHECK constraint is deferred.**

Checklist item 1 states: "The CHECK constraint on `security_needs.resolution` is deferred to 1.0 numbered migrations; the service layer refuses cred-typed writes to `resolution` in the meantime."

The spec body (§Schema) presents the CHECK as present:

```sql
ADD CONSTRAINT security_needs_cred_no_resolution
  CHECK (kind <> 'credential' OR resolution IS NULL);
```

These two statements conflict. The spec body implies the constraint is live. The checklist says it is not. If the CHECK is deferred, the only gate is a service-layer refusal. Questions:

1. Is the service-layer refusal tested? The checklist does not name a test.
2. Can a direct SQL write (e.g. from a migration, a REPL, or a backup restore) bypass the service layer and write a `resolution` on a cred-typed need? Yes, because the CHECK is absent.

**Severity: high.** This is the safety-net invariant. If a future code path writes `resolution` on a cred-typed need without going through the service layer, the credential value lands in plaintext in `security_needs` and is readable by every viewer with access to the engagement. The whole vault design exists to prevent this.

**Recommendation.** Either:
- (a) Ship the CHECK constraint now (edit `0000_app.sql` per the pre-1.0 rule), or
- (b) Add a clear warning to the spec body: "The CHECK constraint is deferred to numbered migrations. Until then, the service layer is the sole gate. A direct SQL write that sets `resolution` on a `kind = 'credential'` row is a security incident."

Add integration tests that verify the service layer rejects `resolution` on cred-typed needs.

### INV-15 (Owner-only read, no admin peek)

**No issues found.** The implementation (`assertOwner` in `security-vault.ts`) checks `session.userId === owner_user_id` on every label/metadata read. Non-owners see only `countCredentials`. Access logs stamp every materialize.

### INV-16 (Environment-bound decryption)

**No issues found.** The `materialize` method checks `row.kekId !== kekId` and marks mismatched rows as dead. `deriveKekId` is deterministic from the passphrase.

### INV-17 (Crypto-shred on death)

**No issues found.** `purgeEngagement` hard-deletes rows. `sweepExpired` hard-deletes by TTL. `deleteCredential` hard-deletes by user action. No soft delete exists. The `ON DELETE CASCADE` on `engagement_credential_access` preserves the audit trail's structure but drops the credential row.

## Against the threat model (Appendix B)

### T-8 not updated for the vault

T-8 ("Loot encryption bypass") covers plaintext credentials in `security_files` and synthetic-account lifecycle. Part 10 introduces `engagement_credentials` with ciphertext. T-8 does not mention the vault, its encryption scheme, or the new threat surfaces it creates (key compromise, kek mismatch, backup-scrub failure).

**Recommendation.** Add a T-16 or extend T-8 to cover:

- **Vault key compromise.** An attacker who obtains `VALET_ENCRYPTION_KEY` can decrypt every `engagement_credentials.ciphertext` row. Mitigation: key rotation (§Operations), env-bound `kek_id`, backup-scrub pipeline.
- **Backup-scrub omission.** A production backup restored into staging without scrubbing `engagement_credentials.ciphertext` exposes every credential to the staging environment. The spec documents the scrub procedure but it is a manual pipeline step, not an automated gate.

### Missing threat: tripwire index heap leak

The tripwire index (`TripwireIndexSnapshot`) holds credential values as Buffers in the api process's heap. Two scenarios expose them:

1. **Heap dump.** A `v8.writeHeapSnapshot()` call (or a SIGUSR2 handler that writes one) while the tripwire index is live captures every credential value in the snapshot file. Part 11 addresses this for `sec_http_request` (INV-24, heap-dump guard, SIGUSR2 override) but Part 10 does not. The tripwire index lives for the entire dispatch window (send seam) or the entire child session lifetime (persist seam).

2. **Error serialization.** If an error thrown during tripwire scanning includes the match buffer in its stack trace or message, the credential value enters a log or an error-reporting pipeline.

**Severity: medium.** Part 11's mitigations (heap-snapshot guard, signal override) partially cover this since the api process is the same. But Part 10 should explicitly state that the Part 11 heap-hygiene guards protect the tripwire index too, or add its own guards.

### Missing threat: `beforeEntryPersist` hook not wired on a future code path

The persist-seam tripwire (`persist-tripwire.ts`) is wired at `EngineHost.buildChildSession`. A future code path that creates a child session without going through `buildChildSession` (e.g. a new test harness, a migration tool, or a direct `Thread` construction) would bypass the hook.

**Severity: low.** Today, `buildChildSession` is the only factory. But the spec should name this as a coupling risk: "The persist-seam tripwire depends on `buildChildSession` being the sole factory for security-persona child sessions. Any new factory MUST wire `buildPersistTripwire`."

## Against the implementation (PR diff)

### Tripwire: hard-fail vs. redact-and-warn

**Spec says:** "A tripwire hit is a security incident, not a warning. The cell fails."

**Implementation says** (comment in `tripwire.ts`): "v1 does NOT hard-fail the cell — that requires engine-level coordination and lands in a follow-up."

The implementation redacts in place and records a `security_incidents` row, but does not fail the cell. The cell continues running with the redacted content.

**Severity: high.** The spec and implementation disagree on a normative behavior. The spec says the cell fails. The implementation says it does not. The checklist (item 4) does not mention this gap.

**Recommendation.** Either:
- (a) Update the spec to say: "v1 redacts the bytes and records an incident. Hard cell failure on a tripwire hit is deferred to a follow-up that adds engine-level coordination." Or
- (b) Implement the hard-fail.

Option (a) is safer for v1 shipping; the redaction still prevents the value from reaching the wire or the DB.

### Egress redaction deferred

**Spec says:** "Egress: The in-sandbox gateway filters stdout and stderr through `redactBytes(credentialIndex)` before forwarding to the api."

**Implementation says** (checklist item 4): "The engine's in-sandbox gateway egress redactor is deferred as a hardening pass; the persist + send seams close every path that leaves the api process."

The spec body describes three seams (persist, send, egress). The implementation ships two. The gap is acknowledged in the checklist but not in the spec body's §Redaction section.

**Severity: medium.** The persist + send seams cover every path where data leaves the api process (DB writes and WS frames). The egress seam covers a defense-in-depth path: a persona that reads a credential file and prints it to stdout would have the value redacted before the gateway forwards stdout to the api. Without the egress seam, the stdout bytes reach the api process unredacted, where the send seam catches them on the WS frame.

The residual risk: if a persona prints a credential to stdout and the sandbox gateway forwards it, the value enters `engine_entries.parts` (via the tool-result that captures stdout). The persist seam catches this. But between the stdout write and the persist-seam scan, the value sits in api-process memory in a tool-result buffer.

**Recommendation.** Add a note to §Redaction: "v1 ships the persist and send seams. The egress seam (in-sandbox gateway filtering) is deferred as a hardening pass. The persist + send seams cover every path that leaves the api process. The residual risk is that a credential value may briefly sit in an api-process tool-result buffer before the persist seam scans and redacts it."

### Pre-create vault route not implemented

**Spec says:** `POST /security/vault` (pre-create, no session id). An ephemeral vault created before the engagement exists, garbage-collected after 1 hour.

**Implementation:** Only `POST /:id/security/vault` exists (post-create). There is no `POST /security/vault` route in `security.ts`.

**Severity: low.** The pre-create flow is a UX convenience (the wizard creates credentials before the session exists). The post-create flow works. But the spec describes the pre-create flow as part of the §Ingress contract ("At engagement start").

**Recommendation.** Add a checklist note: "Pre-create vault (`POST /security/vault` without a session id) is deferred. The wizard writes credentials after session creation via `POST /:id/security/vault`."

### Fingerprint: spec matches implementation

**Spec says:** SHA-256 truncated to 16 bytes, base64url-encoded.

**Implementation** (`fingerprintOf` in `security-vault.ts`):

```ts
const digest = createHash("sha256").update(value).digest();
return digest.subarray(0, 16).toString("base64url");
```

**No issue.** The implementation matches the spec.

### File path: spec body vs. implementation

**Spec body** (§Dispatch, §Vocabulary): `/etc/valet/creds/vault/<label>[.<ext>]` and `/etc/valet/creds/vault/`.

**Implementation** (`credsFileName` in `security-vault.ts`): `vault-<label>.<ext>` under `/etc/valet/creds/`.

**Checklist item 3**: `/etc/valet/creds/vault-<label>.<ext>`.

The spec body uses a `vault/` subdirectory. The implementation uses a `vault-` prefix (flat files). The checklist matches the implementation.

**Severity: low.** A cosmetic inconsistency. The persona prompt renders whichever path the implementation uses.

**Recommendation.** Update §Dispatch and §Vocabulary in the spec body to match the implementation: `/etc/valet/creds/vault-<label>.<ext>`.

## Cross-check against PR #421 (1Password credential backend)

### `credsMount` path coexistence

**Part 10** materializes credentials as files at `/etc/valet/creds/vault-<label>.<ext>`.

**PR #421's sandbox secret broker** injects secrets as environment variables via `valet-secrets run --env NAME=op://vault/item/field -- cmd`. The broker resolves `op://` references through the 1Password SDK and places values in the child process's environment. It does not write files to `/etc/valet/creds/`.

**Finding: no path conflict.** The two systems use different delivery mechanisms (files vs. env vars) and different mount paths. They can coexist in the same sandbox without collision. A persona that needs a vault credential reads a file. A persona (or agent tool) that needs a 1Password secret uses the broker CLI.

### Tripwire vs. sandbox secret broker

**Part 10's tripwire** scans `engine_entries` and WS frames for credential values. It catches values that leak into the transcript.

**PR #421's sandbox secret broker** prevents the value from entering the transcript at all. The agent never receives the secret; the broker injects it into a child process's environment, and the child process uses it without the agent seeing it.

**Finding: complementary, not duplicative.** The broker is a prevention mechanism (the value never enters the transcript). The tripwire is a detection mechanism (catches values that do enter the transcript). When using the broker, the tripwire has nothing to scan for because the value never appears. When using the vault (Part 10), the tripwire is the safety net because the persona reads the file and might echo the value.

**Recommendation.** The spec should acknowledge PR #421's broker as a complementary mechanism: "When the sandbox secret broker (PR #421) is available, prefer it for credentials that can be injected as environment variables. The broker prevents transcript exposure at the source; the vault's tripwire detects it after the fact."

### Vault encryption vs. 1Password `op://` references

**Part 10** stores credential ciphertext in `engagement_credentials` under `VALET_ENCRYPTION_KEY`.

**PR #421** stores no secret material. Credential rows carry `metadata.onepassword: { reference, tokenScope }`. The resolver dereferences `op://` URIs at use time through the 1Password SDK.

**Finding: natural integration point exists but is not named.**

The `engagement_credentials` schema has a `kind` field and a `ciphertext` column. A natural extension: add a `kind` value (e.g. `onepassword-ref`) where `ciphertext` is NULL and `meta_json` carries the `op://` reference. `materialize()` would resolve the reference through the 1Password SDK instead of decrypting local ciphertext. Benefits:

- No secret material stored at all (not even ciphertext).
- Key rotation is moot for referenced credentials.
- The vault's per-engagement scoping, audit logging, and TTL still apply.

**Recommendation.** Add a non-goal or future-work note to Part 10: "The vault schema can support reference-based credentials (e.g. `op://` URIs resolved at materialize time) by storing a reference in `meta_json` with `ciphertext` NULL. This integration with PR #421's 1Password backend is a natural extension. v1 stores ciphertext only."

### Owner-precedence contract

**PR #421** defines `resolveUserCredentialRead` / `resolveOrgCredentialRead` as the canonical credential-read path. Credentials are per-service (e.g. "the GitHub token for user X in org Y") and follow an owner-precedence contract: user-owned credentials override org-owned ones.

**Part 10's vault** is per-engagement, not per-service. A vault credential is scoped to one security engagement and is owned by the engagement creator. The vault does not participate in the service-level precedence contract.

**Finding: correct separation.** The two systems serve different purposes:

- PR #421's credential resolution answers: "What token does this session use for GitHub?" It resolves by service, user, and org.
- Part 10's vault answers: "What credentials does this security engagement need to test the target?" It resolves by engagement and label.

A vault credential is ephemeral (TTL, crypto-shred on engagement death). A service credential is persistent (lives as long as the integration). Mixing them in the same precedence contract would be a category error.

**Recommendation.** No change needed. The spec should not make the vault participate in the service-level precedence contract. The separation is intentional and correct.

## Summary of findings

| # | Finding | Severity | Section |
|---|---------|----------|---------|
| 1 | `needle.length < 8` skip not acknowledged in spec | Medium | INV-12 |
| 2 | `tripwireIndex` decrypts outside `materialize`, contradicting INV-13 | Medium | INV-13 |
| 3 | CHECK constraint deferred but spec body presents it as live | High | INV-14 |
| 4 | T-8 not updated for the vault's encryption and threat surfaces | Medium | Threat model |
| 5 | Tripwire index heap leak not covered as a threat | Medium | Threat model |
| 6 | `beforeEntryPersist` coupling risk not documented | Low | Threat model |
| 7 | Tripwire does not hard-fail the cell (spec says it does) | High | Implementation |
| 8 | Egress seam deferred but not acknowledged in spec body | Medium | Implementation |
| 9 | Pre-create vault route (`POST /security/vault`) not implemented | Low | Implementation |
| 10 | File path mismatch between spec body and implementation | Low | Implementation |
| 11 | Natural `op://` reference integration point not named | Info | PR #421 cross-check |
| 12 | Tripwire and broker are complementary; spec should say so | Info | PR #421 cross-check |
