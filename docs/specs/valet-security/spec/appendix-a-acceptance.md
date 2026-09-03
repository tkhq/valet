# Appendix A: Acceptance Scenario

*Normative. Conformance: L4.*

An L4 implementation MUST pass the 21-step scenario below in one run from a clean start. The scenario is the falsifiable target for the whole spec. It exercises: the tool inventory (Part 03), the `needs.yml` schema (Part 04), the `pivot-coordinator` persona (Part 05), the `loot.catalog.yml` (Part 06), the `post-pivot-delta` cell mode (Part 01), and the anti-cap checks (Part 07). Every step is mapped to a Valet route or tool call.

## Setup

- **Target repository.** `github.com/example-org/api` (test fixture, ships with the spec under `fixtures/api/`).
- **Commit SHA.** Pinned in `vectors/acceptance-fixture.json::repo_sha`.
- **Engagement id.** `eng-001`.
- **Plan preset.** `full-scan` (materializes to `[threat-model, code-review, sast, dast, fuzz]`).
- **Authorized scope.** From `.valet/security.yml`: `hosts: ["api.example.com"]`, new v1 field `cidrs: ["10.0.0.0/8", "192.168.0.0/16"]`.
- **Clean start.** No prior engagement rows, no loot, no cached tools. Sandbox boots from base image only.
- **DNS mock.** Test harness maps `staging.example.com` to `10.1.2.3`.

## Phase 1: Engagement creation

| Step | Action | Route / tool | Observation | Pass criterion |
|---|---|---|---|---|
| 1 | User creates engagement | `POST /api/sessions` (kind='security') + `POST /security/plan` | `security_engagements` row with `status: planning`, plan YAML populated | 5 cells declared (ordinals 1..5), each `pending` |

## Phase 2: Persona runs

| Step | Action | Route / tool | Observation | Pass criterion |
|---|---|---|---|---|
| 2 | Dispatch `threat-model` (cell 1) | `sec_dispatch cell_id=<cell 1>` | Sandbox starts. Preflight probe reports no scanner tools needed. Persona reads playbook. State doc committed with `status: done, findings: []`. | `security_files` has a `state.yml` revision at `/cells/01-threat-model/state.yml`; cell status flipped to `completed` |
| 3 | Dispatch `code-review` (cell 2) | `sec_dispatch cell_id=<cell 2>` | Preflight probe finds `gitleaks` (baked v8.18.2), runs it. One secret found in `config/db.yml:5`. Persona emits F-cr-1 via `sec_finding_report`. | `security_findings` has 1 row; fingerprint matches vector `finding-001` |
| 4 | Dispatch `sast` (cell 3) | `sec_dispatch cell_id=<cell 3>` | Preflight finds `semgrep` (baked v1.72.0) and `bandit` (baked v1.7.9). `gitleaks` absent (case: image variant); persona installs via GitHub release + SHA verify, updates `/tmp/tools.yml`, commits new revision. Persona runs each scanner. F-sast-1 (SQLi in `api.py:45`), F-sast-2 (XSS in `views.py:78`). | `tools.yml` records gitleaks `installed_at_runtime: true`; findings 2 and 3 fingerprints match vectors `finding-002`/`finding-003` |
| 5 | Dispatch `dast` (cell 4) | `sec_dispatch cell_id=<cell 4>` | Preflight finds `nmap` (v7.94), `nuclei` (v3.2.9). `httpx` absent (case: image variant); persona installs via `go install`. Persona enumerates `https://api.example.com`. 3 findings on `/public/*` (open redirect on `/public/redirect?url=`, missing CSP, verbose errors) F-dast-1..3. Persona also discovers `/admin/users` returns 403 AND `staging.example.com` via DNS enum. Writes `/needs/04-dast.yml` with 2 needs. | 3 findings; `/needs/04-dast.yml` exists with `n-dast-admin-session` (session) and `n-dast-scope-staging` (scope-expansion, params: `host=staging.example.com, discovered_ip=10.1.2.3`) |
| 6 | Dispatch `fuzz` (cell 5) | `sec_dispatch cell_id=<cell 5>` | Preflight finds `ffuf` (v2.1.0), `nuclei`. Persona fuzzes `/api/v1/payment` (endpoint requires valid card). 3 findings: parameter pollution, missing rate limit, CORS misconfig F-fuzz-1..3. Writes `/needs/05-fuzz.yml` with 1 need. | 3 findings; `/needs/05-fuzz.yml` has `n-fuzz-payment-test-data` (test-data) |

**Phase 2 totals:** 5 cells completed. 9 findings total. 3 needs surfaced (2 dast, 1 fuzz).

## Phase 3: Pivot round

| Step | Action | Route / tool | Observation | Pass criterion |
|---|---|---|---|---|
| 7 | Dispatch `pivot-coordinator` (cell 6), mode=discover | `sec_dispatch cell_id=<cell 6>` | Coordinator reads `/needs/04-dast.yml` and `/needs/05-fuzz.yml`. Classifies: `n-dast-scope-staging` -> auto (IP 10.1.2.3 in 10.0.0.0/8); `n-dast-admin-session` -> human; `n-fuzz-payment-test-data` -> human. Executes `scope-auto-include`: writes to `manifest.delta.yml.authorized_hosts: ["staging.example.com"]` and appends to `auto-setups.log`. Writes `/human_setup_ask.md` with 2 sections. Settles `status: yielding`. | `auto-setups.log` has 1 auto success line; `human_setup_ask.md` has 2 sections (`n-dast-admin-session`, `n-fuzz-payment-test-data`); cell status `yielded` |
| 8 | Human answers via web UI or `POST /security/human-response` | `sec_fs_write /human_response.yml` (internal) | `human_response.yml` written with 2 provided entries: admin creds + payment card | `human_response.yml` exists with schema_version=1 and 2 provided rows |
| 9 | Dispatch `pivot-coordinator` (same cell), mode=resume, resolve mode | `sec_dispatch cell_id=<cell 6> mode=resume` | Coordinator calls login endpoint (`.valet/security.yml.login_url`), captures cookies. Calls `sec_loot_write` with credentials `c-human-1`, sessions `s-human-1`, test-data `td-human-1`, cookie jar bundle for `s-human-1`. | `/loot/catalog.yml` has 1 credential, 1 session, 1 test-data. `/loot/cookies-s-human-1.txt` exists in Netscape format |
| 10 | Coordinator computes rerun_plan | (same tool call) | 2 rerun entries: `dast` with delta_targets `{authed_surface: ["https://api.example.com/admin/*"], new_hosts: ["staging.example.com"], auth_scopes: ["admin"]}`; `fuzz` with `test_data: ["payment-card"]` | Vectors `delta-targets-001` and `delta-targets-002` in `delta-targets.json` match |
| 11 | Coordinator writes `/pivot.yml`, settles | `sec_fs_write /pivot.yml`; `sec_cell_complete` | pivot.yml has schema_version=1, `resolved: [3 entries; 1 auto_ok + 2 provided]`, `rerun_plan: [dast, fuzz]`. Cell `completed`. | pivot.yml validates against §5.12 schema |

**Phase 3 totals:** 1 coordinator cell completed. 1 need auto-resolved. 2 needs human-resolved. 2 personas queued for delta.

## Phase 4: Delta re-runs

| Step | Action | Route / tool | Observation | Pass criterion |
|---|---|---|---|---|
| 12 | Runner materializes delta cells | `sec_plan_extend` (new internal route derived from pivot.yml) | 2 new cells: `dast-pivot-r1` (ordinal 7, mode `post-pivot-delta`, reads `[4]`), `fuzz-pivot-r1` (ordinal 8, reads `[5]`) | Plan has 8 cells; cells 7 and 8 have mode `post-pivot-delta` |
| 13 | Dispatch `dast-pivot-r1` | `sec_dispatch cell_id=<cell 7>` | Persona reads `/cells/04-dast/state.yml` (3 findings). Reads `/loot/catalog.yml`, loads `s-human-1` jar. Reads delta_targets from dispatch. Focuses on `/admin/*` and `staging.example.com`. Finds IDOR on `/admin/users` -> F-dast-4 with `traces_to.pivot_need: n-dast-admin-session`. Enumerates `staging.example.com` -> staging API on port 443 -> F-dast-5 with `traces_to.pivot_need: n-dast-scope-staging`. Writes new state doc with 5 findings. | New state.yml has `findings: [F-dast-1, F-dast-2, F-dast-3, F-dast-4, F-dast-5]`; F-dast-4 fingerprint matches vector `finding-010`; F-dast-5 matches `finding-011` |
| 14 | Anti-cap gate on cell 7 | inside `sec_cell_complete` | Check 1 (monotonicity): new count 5 >= prior 3 -> pass. Check 2 (citation): F-dast-4 and F-dast-5 both have `traces_to.pivot_need` set -> pass. Cell `completed`. | Cell status `completed`; no schema-violation errors |
| 15 | Dispatch `fuzz-pivot-r1` | `sec_dispatch cell_id=<cell 8>` | Persona reads `/cells/05-fuzz/state.yml` (3 findings). Reads `td-human-1` from loot. Fuzzes `/api/v1/payment` with malformed expiry -> payment bypass -> F-fuzz-4 with `traces_to.pivot_need: n-fuzz-payment-test-data`. Fuzzes amount field -> integer overflow -> F-fuzz-5 same pivot_need. 5 findings total. | State.yml has 5 findings; F-fuzz-4 matches vector `finding-012`; F-fuzz-5 matches `finding-013` |
| 16 | Anti-cap gate on cell 8 | inside `sec_cell_complete` | Both checks pass. Cell `completed`. | Cell status `completed` |

**Phase 4 totals:** 2 delta cells completed. 4 new findings. Total findings: 9 + 4 = 13.

## Phase 5: Verification

| Step | Action | Route / tool | Observation | Pass criterion |
|---|---|---|---|---|
| 17 | Query engagement | `GET /api/sessions/<id>/security` | Response: `{status: "assessed", cells_settled: 8, cells_assessed: 8, findings_total: 13, needs_total: 3, needs_resolved: 3}` | All 8 cells assessed; 13 findings; 3 needs resolved |
| 18 | Verify fingerprints | test runner reads every finding row | 13 fingerprints computed via reference implementation | Zero mismatches vs vectors `finding-001` through `finding-013` |
| 19 | Verify delta_targets | test runner reads `pivot.yml`, extracts 2 delta payloads | Compares to vectors `delta-targets-001` and `delta-targets-002` | Zero mismatches |
| 20 | Verify tool coverage | test runner reads `tools.yml` from every cell | sast: semgrep v1.72.0, bandit v1.7.9, gitleaks v8.18.2. dast: nmap v7.94, nuclei v3.2.9, httpx v1.6.0. fuzz: ffuf v2.1.0, nuclei v3.2.9. | Every tool present at pinned version |
| 21 | Verify loot | test runner reads `/loot/catalog.yml` and `/loot/cookies-s-human-1.txt` | Catalog: 1 credential + 1 session + 1 test-data. Jar non-empty. | Well-formed loot |

## Pass criterion

The scenario PASSES iff:

- Every step completes without error.
- Every one of the 8 cells settles with `status: completed`.
- 13 findings total (9 from Phase 2, 4 from Phase 4).
- Every finding fingerprint matches its vector.
- Both delta_targets payloads match their vectors.
- Both anti-cap checks pass on both delta cells.
- Every tool install succeeds; no NOT_ASSESSED coverage rows from missing tools.
- `/loot/catalog.yml` well-formed and complete.

The scenario FAILS if any step errors, any cell is not_assessed, any fingerprint mismatches, any delta_targets payload differs, any anti-cap check fails, or any tool install fails.

## Test fixture

Ships with the spec under `fixtures/api/`. Minimal Flask app with intentional vulnerabilities:

- Hardcoded password in `config/db.yml:5` -> F-cr-1.
- SQL injection in `api.py:45` -> F-sast-1.
- XSS in `views.py:78` -> F-sast-2.
- Open redirect on `/public/redirect?url=` -> F-dast-1.
- Missing CSP header -> F-dast-2.
- Verbose error messages -> F-dast-3.
- Parameter pollution on `/api/v1/payment` -> F-fuzz-1.
- Missing rate limit on `/api/v1/payment` -> F-fuzz-2.
- CORS misconfig on `/api/v1/payment` -> F-fuzz-3.
- IDOR on `/admin/users?id=<n>` -> F-dast-4 (delta).
- Staging API on `staging.example.com:443` -> F-dast-5 (delta).
- Payment bypass via malformed expiry -> F-fuzz-4 (delta).
- Integer overflow on payment amount -> F-fuzz-5 (delta).

Manifest (`fixtures/api/.valet/security.yml`):

```yaml
version: 1
authorized_scope:
  hosts: ["api.example.com"]
  cidrs: ["10.0.0.0/8", "192.168.0.0/16"]
login_url: "https://api.example.com/auth/login"
signup_url: null   # create-test-account NOT exercised
personas: {}
tools: []
steps:
  - {ordinal: 1, persona: threat-model, mode: fresh, goal: "Model threats"}
  - {ordinal: 2, persona: code-review, mode: fresh, reads: [1], goal: "Read the code"}
  - {ordinal: 3, persona: sast, mode: fresh, reads: [1], goal: "Static analysis"}
  - {ordinal: 4, persona: dast, mode: fresh, reads: [1], goal: "Dynamic sweep"}
  - {ordinal: 5, persona: fuzz, mode: fresh, reads: [1], goal: "Fuzz payment endpoint"}
```

## Executable integration test

```bash
# Clean start: delete any prior engagement state.
rm -rf /tmp/valet-security-test/eng-001

# Run the test.
python3 docs/specs/valet-security/scripts/run-acceptance.py \
  --api http://localhost:8788 \
  --fixture docs/specs/valet-security/fixtures/api \
  --engagement eng-001 \
  --vectors docs/specs/valet-security/vectors

# Exit 0 on pass, non-zero on fail.
# Emits per-step logs.
```

The runner automates Steps 1..21 including the human-response injection at Step 8 (reads `vectors/acceptance-human-response.yml` and posts it through the api).

`run-acceptance.py` ships as a v2 addition; v1 acceptance runs via the api's own integration test harness (`pnpm --filter @valet/api test`) with a fixture map. The vectors alone (`run-vectors.py`) verify every pure decision; end-to-end runs are the full L4 target.
