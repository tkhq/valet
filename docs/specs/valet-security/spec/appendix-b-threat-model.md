# Appendix B: Threat Model

*Normative.*

This appendix enumerates the threats the v1 spec addresses and the mitigations each threat maps to. Every threat carries a category, an impact, a mitigation path with a section citation, and the residual risk after mitigation.

## Taxonomy

Six categories: tool integrity, scope control, loot integrity, finding integrity, coordinator correctness, cross-engagement isolation.

## Tool integrity

### T-1: Tool install failure (partial toolchain)

**Description.** A persona starts, one or more required tools fail to install (network, APT mirror, GitHub release deleted, SHA mismatch). The persona runs with a partial toolchain.

**Impact.** Missing findings. dast without `nuclei` skips CVE template checks. sast without `bandit` skips Python SAST rules.

**Mitigation.**
- Per-persona preflight probe (Part 03 §3.2) runs before the persona starts and writes `tools.yml`.
- Persona reads `tools.yml`, records `sec_coverage_report status=not_assessed` for every absent tool with the consequence text from the inventory (Part 03 §3.4).
- Verifier persona re-reads every `tools.yml` and emits meta-findings for gaps (Part 07 §7.3).

**Residual risk.** None. A missing tool is detected AND reported. Silent skip is impossible unless the persona lies in its coverage rows, which the verifier audits.

### T-2: Malicious tool binary (supply chain)

**Description.** An attacker compromises a GitHub release server or an APT mirror, serves a malicious binary. The persona downloads and execs it.

**Impact.** Code execution inside the persona sandbox. Attacker could exfiltrate loot, inject false findings, tamper with the engagement tree via `sec_fs_write`.

**Mitigation (v1).**
- SHA-256 checksum verify on every GitHub release install (Part 03 §3.1.2).
- APT installs use HTTPS + GPG signatures (handled by APT, not by this spec).
- Every persona sandbox has restricted egress (allowlisted to `authorized_scope.hosts` for LIVE personas; source-only personas have no live-target egress).

**Mitigation (v2).**
- GPG signature verify for GitHub releases (Appendix C §C.5).

**Residual risk (v1).** An attacker who compromises BOTH the release server and the checksum file (edits the GitHub release page atomically) can inject a malicious binary. High-bar attack: requires GitHub account takeover or MITM on HTTPS.

**Residual risk (v2).** GPG signature closes the gap. Attacker must compromise the developer's private key AND the release server.

### T-3: Tool version drift

**Description.** A persona in one cell installs a different version of a tool than a persona in another cell (e.g. semgrep 1.72.0 vs 1.71.0). Findings diverge.

**Impact.** Report inconsistency. Two cells cite different rule ids for the "same" issue.

**Mitigation.**
- Exact version pin on every install (Part 03 §3.1, INV-6).
- `tools.yml` records the installed version.
- Verifier persona compares installed vs pinned; emits informational findings on drift (Part 07 §7.3).

**Residual risk.** None. Drift is detected and reported.

## Scope control

### T-4: Scope bleed (auto-include out-of-scope host)

**Description.** The coordinator auto-includes a discovered host that is outside `authorized_scope.cidrs`. dast then scans it. Legal liability.

**Impact.** Unauthorized access to a third-party or internal-only network.

**Mitigation.**
- `scope-auto-include` (Part 05 §5.5) checks `discovered_ip in authorized_cidrs`. On no match, `outcome: failed`, need falls to human bucket.
- `auto-setups.log` records every auto-include with the matched CIDR.
- Verifier audits `auto-setups.log` at engagement close.

**Residual risk.** None IF `authorized_cidrs` is configured correctly. A human who writes `authorized_cidrs: ["0.0.0.0/0"]` in `.valet/security.yml` opens the door; that is user error, not a spec defect.

### T-5: Scope expansion without attribution

**Description.** A persona discovers a new host, writes a need, coordinator auto-includes it, delta re-run finds an issue. The report does not name which persona surfaced the need OR the CIDR matched.

**Impact.** Audit gap.

**Mitigation.**
- `needs.yml.detected_from` cites the file, line, and excerpt (Part 04 §4.1).
- `auto-setups.log` records the pattern outcome, the host, and the matched CIDR (Part 05 §5.5).
- Every new finding cites `traces_to.pivot_need` (Part 07 §7.2).

**Residual risk.** None. Full provenance chain exists in the tree.

## Loot integrity

### T-6: Session propagation to the wrong persona

**Description.** Coordinator copies an admin session to a persona that should not have it. That persona uses admin to test payment endpoints (wrong privilege level; findings are invalid).

**Impact.** Findings are misleading (tested with admin privilege that the intended test would not have).

**Mitigation.**
- `propagate-session` (Part 05 §5.6) only propagates to personas the need's `would_unblock.surface_added` names. If the need says "admin session unlocks `/admin/*`", only personas testing `/admin/*` receive the jar.
- Verifier audits every propagation entry in `auto-setups.log` against the need's declared surface.

**Residual risk.** None IF personas declare `would_unblock.surface_added` honestly. A persona that lies is a persona bug, not a coordinator defect.

### T-7: Coordinator halts mid-resolve (partial loot)

**Description.** Coordinator crashes after writing a credential row but before writing the matching session row. Personas read partial loot.

**Impact.** Personas fail to load sessions; re-runs fail.

**Mitigation.**
- `sec_loot_write` (Part 06 §6.4) writes the catalog AND every cookie jar in one server-side transaction. A crashed coordinator's write is either fully committed or not committed at all.

**Residual risk.** None. Transaction is atomic.

### T-8: Loot encryption bypass (plaintext credential theft)

**Description.** An attacker reads the engagement's `security_files` rows, extracts plaintext credentials from `/loot/catalog.yml`.

**Impact.** Credential disclosure.

**Mitigation (v1).**
- Filesystem access control: `security_files` rows are scoped to the engagement; only the engagement's org users may read.
- Ephemeral synthetic accounts (`create-test-account`) SHOULD be disabled at engagement close.
- Human-provided credentials SHOULD be revoked after engagement close.

**Mitigation (v2).**
- Encrypt `/loot/catalog.yml` with an engagement-scoped key (Appendix C §C.3).

**Residual risk (v1).** If ACLs are misconfigured (an engagement made org-wide-readable by accident), plaintext leaks. Deployment error, not a spec defect.

## Finding integrity

### T-9: Findings without pivot_need (provenance loss)

**Description.** A persona emits findings in a delta re-run but does not cite `traces_to.pivot_need`.

**Impact.** Report cannot answer "why did we find this in the delta and not the original run?"

**Mitigation.**
- INV-3 (Part 00).
- Check 2 (Part 07 §7.2): `sec_cell_complete` refuses the settlement on missing citation.

**Residual risk.** None. Automatic enforcement.

### T-10: Finding-count decrease (hidden findings)

**Description.** Delta re-run's state doc `findings[]` has fewer entries than the original. Findings hidden.

**Impact.** Incomplete report.

**Mitigation.**
- INV-2 (Part 00).
- Check 1 (Part 07 §7.1): `sec_cell_complete` refuses on count decrease.

**Residual risk.** None. Automatic enforcement.

### T-11: Fingerprint collision

**Description.** Two distinct findings hash to the same 20-byte Blake2b digest.

**Impact.** One is silently deduplicated (lost).

**Mitigation.**
- Blake2b at 20 bytes provides 2^80 collision resistance (Part 02 §2.3). Practical bound: < 10^-38 collision probability at 10,000 findings.
- Verifier MAY audit for collisions (v2, Appendix C §C.9).

**Residual risk.** Cryptographically negligible.

## Coordinator correctness

### T-12: Auto-catalog false positive (need incorrectly auto-resolved)

**Description.** Coordinator auto-resolves a need it should not (bug in `scope-auto-include` misparses a CIDR, `propagate-session` copies the wrong jar).

**Impact.** Same as T-4 (scope bleed) or T-6 (wrong privilege).

**Mitigation.**
- Vectors in §D.4 pin every L3 pattern outcome (6 vectors).
- Verifier audits `auto-setups.log` at engagement close.

**Residual risk.** None IF vectors cover every branch. Vectors omit an edge case, that branch may fail silently. This is a spec-quality risk.

### T-13: `delta_targets` computation error

**Description.** Coordinator computes an incorrect `delta_targets` (includes surface already tested, or omits surface that should be).

**Impact.** Duplicate work (redundant findings) or missing findings.

**Mitigation.**
- Vectors in §D.2 pin the computation (2 vectors, acceptance-scenario shape).
- Runner runs vectors on every implementation change.

**Residual risk.** None IF vectors cover the shape space.

## Cross-engagement isolation

### T-14: Cross-engagement tool state (nmap output bleed)

**Description.** Two engagements run concurrently. Engagement A's persona writes nmap output to `/tmp/nmap-scan.xml`. Engagement B's persona reads the same path, treats it as its own.

**Impact.** Findings from engagement A appear in engagement B's report.

**Mitigation.**
- INV-7 (Part 00). Every persona writes tool output under `/workspace/tool-out/<engagement id>/<cell id>/*`.
- Sandboxes mount no shared writable volumes. `/tmp` is sandbox-local.

**Residual risk.** None IF the deployment isolates `/tmp` per sandbox. A misconfigured shared `/tmp` volume (e.g. a poorly-implemented Kubernetes emptyDir) opens the gap. Deployment concern.

### T-15: Cross-engagement loot reuse (credential misuse)

**Description.** Engagement A stores loot. Engagement B (different target) reads engagement A's loot, uses credentials on the wrong target.

**Impact.** Credential misuse.

**Mitigation.**
- v1: `/loot/catalog.yml` is per-engagement; `security_files` filters on `engagement_id`. Cross-engagement reads are impossible.
- v2 shared loot store (Appendix C §C.6) SHOULD scope by `org_id` and `host`.

**Residual risk (v1).** None.

## Summary table

| Threat | Category | Impact | Mitigated by | Residual risk |
|---|---|---|---|---|
| T-1 | Tool integrity | Missing findings | Preflight probe, `tools.yml`, verifier audit | None |
| T-2 | Tool integrity | Code execution in sandbox | SHA-256 verify (v1), GPG signatures (v2) | Low (v1), None (v2) |
| T-3 | Tool integrity | Inconsistent findings | Version pin, verifier audit | None |
| T-4 | Scope control | Legal liability | `scope-auto-include` CIDR check | None (if config correct) |
| T-5 | Scope control | Audit gap | `detected_from`, `auto-setups.log`, `traces_to.pivot_need` | None |
| T-6 | Loot integrity | Wrong-privilege findings | `propagate-session would_unblock` check | None (if personas honest) |
| T-7 | Loot integrity | Rerun failure | `sec_loot_write` atomic transaction | None |
| T-8 | Loot integrity | Credential disclosure | Filesystem ACL (v1), encryption (v2) | Low (v1), None (v2) |
| T-9 | Finding integrity | Audit gap | Check 2 in `sec_cell_complete` | None |
| T-10 | Finding integrity | Hidden findings | Check 1 in `sec_cell_complete` | None |
| T-11 | Finding integrity | Silent dedup | Blake2b 20-byte, birthday bound | Negligible |
| T-12 | Coordinator correctness | Scope bleed / wrong privilege | Vectors §D.4, verifier audit | Low (vector coverage) |
| T-13 | Coordinator correctness | Duplicate / missing findings | Vectors §D.2 | Low (vector coverage) |
| T-14 | Cross-engagement isolation | Findings bleed | Sandbox-local `/workspace/tool-out/` | Deployment concern |
| T-15 | Cross-engagement isolation | Credential misuse | Engagement-scoped `security_files` | None (v1) |

## Out-of-scope threats

Deployment concerns, not spec defects.

**A-1: Orchestrator compromise.** An attacker who owns the Valet api process can inject findings, modify loot, disable checks. Mitigation: harden the api deployment (K8s RBAC, audit logs, image signing).

**A-2: Human input tampering.** An attacker who owns the user account can supply malicious credentials or test data. Mitigation: user auth (out of scope for this spec).

**A-3: Sandbox escape.** A persona that escapes its sandbox can read every engagement tree. Mitigation: sandbox runtime enforcement (out of scope).

**A-4: Network MITM.** MITM on HTTPS between the sandbox and github.com can inject malicious binaries. Mitigation (v1): SHA-256 verify. Mitigation (v2): GPG signatures.

Each is assumed out of scope for the spec but should be tracked at deployment level.
