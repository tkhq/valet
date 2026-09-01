# Part 05: Pivot Coordinator and Delta Re-runs

*Depends on: Part 00, Part 01, Part 04. Conformance: L3 (L4 for `create-test-account`, `tool-auth-reuse`).*

## Purpose

This part defines the `pivot-coordinator` persona, its two modes (discover, resolve), the five auto-catalog patterns, the `delta_targets` computation, and the `post-pivot-delta` dispatch contract. It ships as the twelfth bundled persona (`packages/plugin-security/personas/pivot-coordinator.md`) with a matching playbook (`packages/plugin-security/playbooks/pivot-coordinator.md`).

## Persona identity and dispatch

The pivot-coordinator is a bundled Valet persona (add `PIVOT_COORDINATOR_PERSONA = "pivot-coordinator"` to `packages/plugin-security/src/lib/personas.ts`, extend `BUNDLED_PERSONAS`, mark `KNOWN_PERSONAS` accordingly, extend `KNOWN_PLAYBOOKS`).

Dispatch prompt shape (as `buildDispatchPrompt` renders it):

```
CELL <ordinal>: <persona=pivot-coordinator> (mode=<fresh|resume>)
GOAL: Resolve every need from prior cells; write pivot.yml.
READS: [2, 3, 5]   # ordinals whose /needs/*.yml the coordinator MAY read
AUTHORIZED CIDRS: 10.0.0.0/8, 192.168.0.0/16
LOOT AT: /loot/catalog.yml (append; two-phase commit)
PROTOCOL: /protocol.md
PLAYBOOK: /playbooks/pivot-coordinator.md
```

The runner cell (the `security-engagement-runner` skill) dispatches the coordinator ONCE per pivot round. In discover mode, the coordinator writes `human_setup_ask.md` and settles with `status: yielding` iff the human bucket is non-empty; otherwise it settles with `status: done`. On the human's response (`human_response.yml` write into the tree), the runner re-dispatches the SAME cell (fresh child, `mode: resume`) into resolve mode; the coordinator reads the response, executes resolutions, writes `pivot.yml`, and settles with `status: done`.

## Discover mode

**Inputs.**
- The `reads[]` cell ordinals (from `security_cells.reads`).
- The engagement's `authorized_cidrs` (from `.valet/security.yml::authorized_scope.cidrs`; new v1 field, additive; a repo that only names `hosts` reads with `cidrs: []` and the coordinator can auto-approve no scope needs).
- The current `/loot/catalog.yml` (may be empty on round 1).

**Steps (normative).**

1. **Read every `/needs/*.yml`.** `sec_fs_list prefix=/needs/`, then `sec_fs_read` each entry. Skip a cell that has no `/needs/*.yml` (that cell had no needs).
2. **Classify every need** with the algorithm in Part 04 §4.3.
3. **Execute every auto-bucket need's pattern** (§5.5-5.10 for the specific pattern), appending one line to `auto-setups.log` per need.
4. **Merge every human-bucket need** by `(kind, surface_added)`. Two personas that need the same admin session on the same host merge into one section.
5. **Write `human_setup_ask.md`** with one section per unique human need.
6. **Settlement check.** If the human bucket is empty (every need auto-resolved), write state doc with `status: done`. Else write state doc with `status: yielding`.

**Outputs.**
- `/cells/<own>/auto-setups.log` (JSONL, one line per auto need).
- `/human_setup_ask.md` (markdown; empty when every need auto-resolved).
- `/cells/<own>/state.yml`.

**`auto-setups.log` line shape (JSONL, one line per need):**
```json
{"need_id":"n-dast-scope-staging","pattern":"scope-auto-include","outcome":"ok","host":"staging.example.com","matched_cidr":"10.0.0.0/8"}
{"need_id":"n-dast-admin-session","pattern":"","outcome":"skipped","reason":"no auto pattern; queued for human"}
{"need_id":"n-fuzz-payment-test-data","pattern":"","outcome":"skipped","reason":"no auto pattern; queued for human"}
```

## Resolve mode

**Inputs.**
- `/human_response.yml` (schema below).
- `/cells/<own>/auto-setups.log` (from discover mode).

**Steps (normative).**

1. **Read `/human_response.yml`.** Parse YAML. Extract `needs[]`.
2. **Apply human inputs.** For each provided need:
    - `kind: credential` OR `kind: session`. Call the login endpoint (if the engagement's `.valet/security.yml` names one) with the provided credentials; capture `Set-Cookie` into `loot/cookies-s-human-<n>.txt` (Netscape format); write a `credentials` row and a `sessions` row via `sec_loot_write`.
    - `kind: test-data`. Write a `test_data` row with the payload.
    - `kind: tool-auth`. Write a `tool_auth` row with the payload.
3. **Compute the rerun plan.** For each persona whose needs were resolved (auto OR human), compute `delta_targets` (§5.4). Materialize one rerun entry per (persona, resolved needs subset).
4. **Write `/pivot.yml`** with the resolved and rerun blocks (schema §5.12).
5. **Settle** with `status: done`.

**`human_response.yml` schema (normative):**
```yaml
schema_version: 1
responded_at: <iso8601 UTC>
needs:
  - need_id: <string, matches human_setup_ask.md section>
    provided:
      # kind: credential / session
      username: <string>
      password: <string>
      # kind: test-data (payment card)
      card_number: <string>
      cvv: <string>
      expiry: <string>
      # kind: tool-auth (tool-specific)
      api_key: <string>
      license_key: <string>
      # ... etc, per kind
```

## `delta_targets` computation

For every resolved need in the pivot round, append to the OWNING PERSONA'S delta payload:

- `kind: session` OR `kind: credential`. Append `would_unblock.surface_added` to `authed_surface`. If the resolved loot entry names a `role`, append the role to `auth_scopes`.
- `kind: scope-expansion`. Append `params.host` to `new_hosts`. If `would_unblock.surface_added` names URLs on that host, append them to `authed_surface`.
- `kind: test-data`. Append the loot entry's `kind` (e.g. `payment-card`) to `test_data`.
- `kind: tool-auth`. Append `params.tool` to `tool_auth`.

Deduplicate every field. Group by persona (a persona with 2 resolved needs contributes both to its own delta payload).

**Pseudocode (pure, normative):**

```python
def compute_delta_targets(persona, resolved_needs, loot):
    """
    persona: str
    resolved_needs: [ need-dict, ... ]  # every need this persona had resolved
    loot: current loot catalog (§6.1)
    Returns: dict with 5 sorted, deduplicated lists.
    """
    out = {
        "authed_surface": set(),
        "new_hosts": set(),
        "auth_scopes": set(),
        "test_data": set(),
        "tool_auth": set(),
    }
    for need in resolved_needs:
        kind = need.get("kind")
        wu = need.get("would_unblock", {}) or {}
        surface = wu.get("surface_added", []) or []
        params = (need.get("proposed_resolution", {}) or {}).get("auto", {}).get("params", {}) or {}

        if kind in ("session", "credential"):
            for s in surface:
                out["authed_surface"].add(s)
            # If a loot credential exists for this session, its role -> auth_scopes.
            for cred in loot.get("credentials", []):
                if cred.get("role"):
                    out["auth_scopes"].add(cred["role"])
        elif kind == "scope-expansion":
            host = params.get("host")
            if host:
                out["new_hosts"].add(host)
            for s in surface:
                out["authed_surface"].add(s)
        elif kind == "test-data":
            # loot has one test_data row per resolved test-data need; use its kind.
            for td in loot.get("test_data", []):
                if td.get("kind"):
                    out["test_data"].add(td["kind"])
        elif kind == "tool-auth":
            tool = params.get("tool")
            if tool:
                out["tool_auth"].add(tool)

    return {k: sorted(v) for k, v in out.items()}
```

**Example (dast delta):**

```yaml
delta_targets:
  authed_surface: ["https://api.example.com/admin/*"]
  new_hosts: ["staging.example.com"]
  auth_scopes: ["admin"]
  test_data: []
  tool_auth: []
```

## Auto-catalog pattern 1 (L3): `scope-auto-include`

**Purpose.** Auto-approve a scope-expansion need when the discovered host's IP sits in `authorized_cidrs`.

**Inputs.**
- `params.host` (string).
- `params.discovered_ip` (string).
- `ctx.authorized_cidrs` (list of CIDR strings).

**Steps.**
1. Parse `discovered_ip` as an IP address. Reject malformed with `outcome: failed, reason: "malformed IP"`.
2. For each CIDR in `authorized_cidrs`, check if the IP sits inside. Use `ipaddress.ip_address(ip) in ipaddress.ip_network(cidr, strict=False)`.
3. On match: append `host` to `/manifest.delta.yml.authorized_hosts` (append-only). Write to `auto-setups.log`: `{"need_id": ..., "pattern": "scope-auto-include", "outcome": "ok", "host": ..., "matched_cidr": ...}`. The `dast`, `fuzz`, and `exploit` personas re-check `authorized_scope` on dispatch and see the new host.
4. On no match: `{"need_id": ..., "pattern": "scope-auto-include", "outcome": "failed", "reason": "IP not in authorized CIDRs"}`. Need falls through to the human bucket.

**Threat mitigation.** Prevents scope bleed. See Appendix B §T-4.

## Auto-catalog pattern 2 (L3): `propagate-session`

**Purpose.** Copy an existing session's cookie jar file from `/loot/` to a target persona's `/cells/<NN>-<slug>/loot/`.

**Inputs.**
- `params.source_session_id` (string).
- `params.target_persona` (string).

**Steps.**

1. Look up session by `id` in `loot.catalog.yml.sessions`. If absent, `outcome: failed, reason: "session not found"`.
2. Read the cookie jar text at `loot/cookies-<session id>.txt` via `sec_fs_read`.
3. Write the cookie jar text via `sec_fs_write` at the target's path: `/cells/<target NN>-<slug>/loot/cookies-<session id>.txt`.
4. `auto-setups.log`: `{"need_id": ..., "pattern": "propagate-session", "outcome": "ok", "source_session_id": ..., "target_persona": ...}`.

**Idempotence.** If the target path already carries the cookie jar (a prior propagation), the file copy is a no-op. Outcome is still `ok`.

**File copy, not symlink.** `sec_fs_write` writes a new `security_files` revision (a full content copy). Symlinks are not part of the engagement tree.

## Auto-catalog pattern 3 (L3): `rerun-with-existing-loot`

**Purpose.** Re-dispatch a persona with `mode: post-pivot-delta` and a `delta_targets` payload derived from existing loot (no new signup, no scope change; just re-test with existing artifacts).

**Inputs.**
- `params.persona` (string).
- `params.loot_ids` (list of strings; every id MUST exist in `loot.catalog.yml`).

**Steps.**

1. Verify every id in `loot_ids` exists in `loot.catalog.yml`. If any missing, `outcome: failed, reason: "loot not found"`.
2. **Derive `delta_targets` from loot** (see the derivation rule below).
3. Add a `(persona, delta_targets)` entry to `pivot.yml.rerun_plan`.
4. `auto-setups.log`: `{"need_id": ..., "pattern": "rerun-with-existing-loot", "outcome": "ok", "persona": ..., "loot_ids": [...]}`.

**Derivation rule for `authed_surface` when the need carries no `would_unblock.surface_added`.**

When a `session` loot entry names `host: <H>`, this pattern SHALL append `https://<H>/*` to `authed_surface`. This is the normative shortcut for a re-run whose only signal is "we hold a session for host H; test H with it". Similarly, when a `credential` loot entry names `role`, this pattern SHALL append the role to `auth_scopes`.

Without this rule, `compute_delta_targets` on a `rerun-with-existing-loot` need with no `surface_added` produces an empty payload (nothing to test). The derivation rule closes that gap. See Appendix D §D.4 vector `auto-catalog-005` for the pinned outcome.

## Auto-catalog pattern 4 (L4): `create-test-account`

**Purpose.** HTTP POST a synthetic signup with generated credentials; capture the resulting session.

**Inputs.**
- `params.signup_url` (string).
- `params.username_template` (string, OPTIONAL; default: `pentest-<engagement_slug>-r<round>-<suffix>`).
- `params.password_template` (string, OPTIONAL; default: random 20-char alphanumeric).

**Steps.**

1. Generate `<username, password>` from templates. `<suffix>` is the persona id.
2. HTTP POST to `signup_url` with `{"username": <u>, "password": <p>}` (JSON). Body encoding matches the endpoint's declared content type.
3. On 2xx or 3xx: capture `Set-Cookie` into `/loot/cookies-s-auto-<n>.txt` (Netscape format). Write `credentials` + `sessions` rows via `sec_loot_write`.
4. On 4xx / 5xx: `outcome: failed, reason: "signup rejected: <status> <body-snippet>"`. Need falls to the human bucket.

**Idempotence.** Generated username is deterministic (`pentest-<slug>-r<round>-<suffix>`). A retried coordinator produces the same username, so the second attempt's 4xx (username taken) means the FIRST attempt succeeded; the coordinator SHOULD look up the existing loot row before retrying.

**Security consideration.** v1 does not encrypt loot (Appendix C §C.3). Synthetic accounts are ephemeral. Human-provided admin credentials SHOULD be revoked after the engagement.

## Auto-catalog pattern 5 (L4): `tool-auth-reuse`

**Purpose.** Copy a tool-auth blob from a shared loot store (cross-engagement cache) into `/loot/catalog.yml`.

**Inputs.**
- `params.tool` (string).

**Steps.**

1. Query the shared loot store (v2 feature, Appendix C §C.6; v1 has no shared store, so this always returns empty).
2. If a match: copy the blob, write a `tool_auth` row via `sec_loot_write`.
3. Otherwise: `outcome: failed, reason: "no cached auth for tool"`. Need falls to the human bucket.

**v1 constraint.** Because v1 has no shared loot store, this pattern's `outcome` is ALWAYS `failed` in v1. The pattern ships for L4 symmetry.

## Delta re-run dispatch contract

When resolve mode writes `pivot.yml`, the runner cell reads `rerun_plan[]` and materializes new cells with `mode: post-pivot-delta`. `parsePlan` adds the new cells with dense ordinals (base design's ordinal rule).

**Dispatch prompt (normative, extends `buildDispatchPrompt`):**

```
CELL <new ordinal>: <persona=dast> (mode=post-pivot-delta)
GOAL: Re-test the delta surface unlocked by the pivot round.
READS: [<original ordinal>]
AUTHORIZED SCOPE: <expanded to include manifest.delta.yml.authorized_hosts>
DELTA TARGETS:
  authed_surface: ["https://api.example.com/admin/*"]
  new_hosts: ["staging.example.com"]
  auth_scopes: ["admin"]
  test_data: []
  tool_auth: []
LOOT AT: /loot/catalog.yml
PROTOCOL: /protocol.md
PLAYBOOK: /playbooks/dast.md
```

**Persona MUST:**

1. Read the ORIGINAL cell's state doc from `sec_fs_read /cells/<original NN>-<slug>/state.yml`. Populate a "seen" set from `findings[]`.
2. Read `/loot/catalog.yml`. Load the session, credential, or test-data payload named in `delta_targets`.
3. Test ONLY the delta surface. Skip every URL, host, actor, or oracle already exercised in the original run.
4. For every new finding, call `sec_finding_report` with `traces_to.pivot_need: <need id from the pivot round>`. The engine tool stamps this automatically from the dispatch's DELTA TARGETS provenance; the persona MAY override for a specific need.
5. Write a new state doc with `findings[]` = seen set + new ids. `sec_cell_complete` enforces the two anti-cap checks (Part 07 §7.1-7.2).

**On any anti-cap violation:** `sec_cell_complete` refuses the settlement and names the specific violation. The persona re-emits the missing rows (backfill prior finding ids) and re-invokes `sec_cell_complete`.

## Auto-catalog idempotence rule

INV-4 (Part 00): the same auto-catalog pattern with the same inputs writes the same loot entries.

Enforcement. Before executing a pattern the coordinator queries `/loot/catalog.yml`:
- `create-test-account`: skip if a `credentials` row exists with the same generated `username`.
- `propagate-session`: no-op if the target cookie jar path already carries the source's content.
- `rerun-with-existing-loot`: no-op if `pivot.yml.rerun_plan[]` already carries a matching entry.
- `scope-auto-include`: skip if `manifest.delta.yml.authorized_hosts` already lists the host.
- `tool-auth-reuse`: skip if a `tool_auth` row for the tool exists.

## `pivot.yml` schema

The coordinator writes `/pivot.yml` at resolve-mode settlement. The runner cell reads it to materialize delta re-run cells.

```yaml
schema_version: 1
resolved_at: <iso8601 UTC>
resolved:
  - need_id: <string>
    outcome: auto_ok | provided | failed
    pattern: <string or null>     # auto pattern name when outcome=auto_ok
    reason: <string or null>      # failure reason when outcome=failed
rerun_plan:
  - persona: <persona id>
    mode: post-pivot-delta
    delta_targets:
      authed_surface: [<url>, ...]
      new_hosts: [<host>, ...]
      auth_scopes: [<role>, ...]
      test_data: [<kind>, ...]
      tool_auth: [<tool>, ...]
    reads: [<original ordinal>]
    from_needs: [<need id>, ...]  # every need whose resolution feeds this rerun
```

**Example.**
```yaml
schema_version: 1
resolved_at: 2026-08-31T16:10:00Z
resolved:
  - need_id: n-dast-scope-staging
    outcome: auto_ok
    pattern: scope-auto-include
    reason: null
  - need_id: n-dast-admin-session
    outcome: provided
    pattern: null
    reason: null
  - need_id: n-fuzz-payment-test-data
    outcome: provided
    pattern: null
    reason: null
rerun_plan:
  - persona: dast
    mode: post-pivot-delta
    delta_targets:
      authed_surface: ["https://api.example.com/admin/*"]
      new_hosts: ["staging.example.com"]
      auth_scopes: ["admin"]
      test_data: []
      tool_auth: []
    reads: [2]
    from_needs: [n-dast-scope-staging, n-dast-admin-session]
  - persona: fuzz
    mode: post-pivot-delta
    delta_targets:
      authed_surface: []
      new_hosts: []
      auth_scopes: []
      test_data: ["payment-card"]
      tool_auth: []
    reads: [3]
    from_needs: [n-fuzz-payment-test-data]
```

## Conformance

**L0.** `classify_need`, `compute_delta_targets`, and every auto-catalog outcome computation ship as pure functions. See vectors in §D.2, §D.4.

**L1.** No coordinator persona at L1 (personas write `needs.yml` but no coordinator runs).

**L2.** Coordinator runs in discover mode. Reads `/needs/*.yml`. Classifies. Writes `human_setup_ask.md`. Auto-catalog execution NOT required.

**L3.** Coordinator runs discover + resolve. Executes `scope-auto-include`, `propagate-session`, `rerun-with-existing-loot`. Writes `/loot/catalog.yml`. Computes `delta_targets`. Materializes `post-pivot-delta` cells.

**L4.** Same as L3, plus `create-test-account` and `tool-auth-reuse` execution.
