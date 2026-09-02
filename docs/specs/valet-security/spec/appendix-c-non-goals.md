# Appendix C: Non-Goals

*Normative.*

This appendix lists every feature v1 explicitly excludes. Every entry names the exclusion, the rationale, and the re-entry seam (how v2 could add it).

## C.1 Multi-round pivot loops

**Exclusion.** v1 runs one pivot round: Phase 2 personas write needs, Phase 3 coordinator resolves, Phase 4 delta re-runs test the delta, done. v2 could run multiple rounds (delta re-runs write new needs, coordinator resolves them, next round tests, etc.).

**Rationale.** One round covers the common case (admin session, scope expansion, test data). Multi-round requires coordinator recursion, cycle detection, and a termination proof. The acceptance scenario (Appendix A) exercises one round.

**Re-entry seam.** Part 05 §5.11 (reserved for v2). v2 extends the coordinator with a bounded loop:
```python
while True:
    needs = read_all_needs_written_since_last_pivot()
    if not needs:
        break
    resolve(needs)
    dispatch_delta_reruns()
    if pivot_round_number >= MAX_ROUNDS:
        raise CoordinatorTerminated("hit round cap")
```
Termination: loop exits on empty needs OR at `MAX_ROUNDS = 3`. Cycle detection: if the same need id reappears, treat as unresolvable.

**Vector delta.** v2 acceptance scenario adds a second round (fuzz's delta re-run writes a fresh need; coordinator resolves; fuzz re-runs again).

## C.2 Verifier audits needs coverage

**Exclusion.** v1 verifier audits tool versions (§7.3) but does NOT audit whether every `/needs/*.yml` need was resolved or explicitly deferred.

**Rationale.** Coordinator is trusted in v1. Auditing needs coverage requires re-reading every `needs.yml`, re-classifying, and diffing against `pivot.yml`. This is redundant work; the acceptance scenario (Appendix A step 21) verifies coverage manually.

**Re-entry seam.** Part 07 §7.4 (reserved for v2).
```python
def audit_needs_coverage():
    all_needs = read_needs_from_all_personas()
    resolved = read_pivot_yml().resolved
    for n in all_needs:
        if n.id not in resolved:
            emit_finding(f"[verifier] need {n.id} dropped: not in pivot.yml.resolved")
```

**Vector delta.** v2 test where coordinator drops a need (bug); verifier emits meta-finding.

## C.3 Loot encryption

**Exclusion.** `/loot/catalog.yml` is plaintext in v1.

**Rationale.** Deployment-level ACLs plus ephemeral synthetic accounts plus revocation-on-close is the v1 posture. Encryption adds key management (rotate, HSM-back). Threat T-8 (Appendix B) covers residual risk.

**Re-entry seam.** Part 06 §6.7. v2 coordinator wraps `sec_loot_write` with AES-256-GCM:
```python
def write_loot_catalog_encrypted(loot, key):
    plaintext = yaml.dump(loot)
    ciphertext = aes_256_gcm_encrypt(plaintext, key, nonce=random_nonce())
    sec_fs_write("/loot/catalog.yml.enc", ciphertext)
```
Personas decrypt on read. Key: HKDF(engagement_id + secret_salt). Salt in the api database.

**Vector delta.** v2 test: coordinator writes encrypted, persona reads and decrypts.

## C.4 MCP daemons (ZAP, Burp, Playwright)

**Exclusion.** v1 uses CLI tools only (nmap, semgrep, nuclei, ffuf, etc.).

**Rationale.** MCP daemons need lifecycle management (start, ready-check, RPCs, shutdown). CLI tools are stateless (exec, capture, done). v1 CLI subset is sufficient for the acceptance scenario.

**Re-entry seam.** Part 03 §3.9. v2 extends the inventory schema:
```yaml
tools:
  - name: zap
    type: mcp_daemon
    start_command: "zap.sh -daemon -port 8080"
    ready_check: "curl http://localhost:8080/health"
    rpc_endpoint: "http://localhost:8080/JSON/"
```
Persona starts the daemon in a background process, polls ready-check, sends RPCs, terminates on cell settle.

**Vector delta.** v2 dast run against a ZAP proxy interception.

## C.5 GPG signature verification for tool binaries

**Exclusion.** v1 verifies SHA-256 checksums. v2 could add GPG signatures.

**Rationale.** SHA-256 covers Threat T-2 acceptably at a high bar (attacker must control both release server and checksum file). GPG closes the gap (attacker needs developer's private key).

**Re-entry seam.** Part 03 §3.10. v2 GitHub release install:
```bash
wget <artifact>
wget <artifact>.asc
gpg --import <maintainer.pubkey>
gpg --verify <artifact>.asc <artifact>
echo "<sha256> <artifact>" | sha256sum -c
```
Public keys ship in the tool catalog config.

**Vector delta.** v2 test: tampered binary rejected by GPG verify.

## C.6 Cross-engagement loot reuse

**Exclusion.** v1 loot is per-engagement. v2 could add a shared loot store scoped to an org.

**Rationale.** Access control complexity: if org A's engagement stores admin credentials, does org B's engagement in the same org need the operating user's approval? v1 sidesteps by re-provisioning per engagement (redundant but safe).

**Re-entry seam.** Part 06 §6.6. v2 adds a `shared_loot` table:
```sql
CREATE TABLE shared_loot (
  id UUID PRIMARY KEY,
  org_id UUID NOT NULL,
  kind TEXT,                 -- 'credential' | 'session' | 'tool_auth'
  host TEXT,
  payload JSONB,
  created_by UUID,
  created_at TIMESTAMP
);
```
Coordinator queries when resolving needs; matches by (org_id, kind, host).

**Vector delta.** v2 test: two engagements in the same org reuse an admin credential.

## C.7 Tool caching layer

**Exclusion.** v1 installs tools from scratch on every cell.

**Rationale.** Correctness first. Installs are seconds-to-minutes; caching is an optimization. Cache invalidation adds state.

**Re-entry seam.** Part 03 §3.11. v2 mounts a cache volume at `/var/cache/valet-tools/` and adds a per-install prep step:
```bash
if [ -f /var/cache/valet-tools/gitleaks-8.18.2 ]; then
  cp /var/cache/valet-tools/gitleaks-8.18.2 /usr/local/bin/gitleaks
  chmod +x /usr/local/bin/gitleaks
else
  # Install as usual, then cache.
  wget && verify && tar && mv
  cp /usr/local/bin/gitleaks /var/cache/valet-tools/gitleaks-8.18.2
fi
```
Cache key: `<tool>-<version>`. Eviction: LRU age-based.

**Vector delta.** v2 test: two engagements share the cache; second uses cached binary.

## C.8 Deferred needs bucket (multi-round dependencies)

**Exclusion.** v1 needs go to `auto` or `human`. v2 adds `deferred` when a need depends on another.

**Rationale.** No multi-round pivots in v1 (C.1). Dependency chains need multi-round.

**Re-entry seam.** Part 04 §4.4. Schema extension:
```yaml
needs:
  - id: n-fuzz-payment
    kind: test-data
    blocked_by: [n-fuzz-session]
```
Classifier:
```python
if need.blocked_by:
    if all(n in resolved for n in need.blocked_by):
        return "auto"
    return "deferred"
```
Coordinator re-evaluates deferred needs on next round.

**Vector delta.** v2 test: fuzz needs session (round 1), then test-data (round 2).

## C.9 Fingerprint collision detection

**Exclusion.** Verifier does NOT check for fingerprint collisions.

**Rationale.** Cryptographically improbable at 20-byte Blake2b (< 10^-38 at 10,000 findings).

**Re-entry seam.** Part 07 §7.5. v2 verifier:
```python
def audit_collisions():
    seen = {}
    for f in all_findings:
        if f.fingerprint in seen:
            emit_finding(f"[verifier] fingerprint collision: {f.id} and {seen[f.fingerprint]}")
        seen[f.fingerprint] = f.id
```

**Vector delta.** v2 test with artificially constructed collision.

## C.10 Loot expiry audit

**Exclusion.** `loot.catalog.yml.sessions[].expires_at` exists but is not audited.

**Rationale.** If a session expires mid-engagement, the using persona hits 401 and marks NOT_ASSESSED. v1 is sufficient. v2 verifier proactively audits.

**Re-entry seam.** Part 07 §7.6. v2 verifier:
```python
def audit_expiry():
    now = utcnow()
    for s in loot.sessions:
        if s.expires_at and s.expires_at < now:
            emit_finding(f"[verifier] session {s.id} expired at {s.expires_at}")
```

**Vector delta.** v2 test: admin session expires mid-engagement.

## Summary

The exclusions above are design tradeoffs, not oversights. v1 optimizes for:
- **Simplicity.** One pivot round. Plaintext loot. CLI tools only.
- **Testability.** Acceptance scenario (Appendix A) exercises L0..L4 without multi-round, encryption, or MCP daemons.
- **Correctness.** SHA-256 verify. Atomic writes. Anti-cap enforcement.

v2 extends without breaking v1. Every re-entry seam is a named section reserved for the extension.
