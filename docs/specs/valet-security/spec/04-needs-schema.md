# Part 04: Needs Schema and Classification

*Depends on: Part 00, Part 01. Conformance: L2.*

## Purpose

This part fixes the `needs.yml` schema personas write when they lack input to test a surface, the six `kind` values, the `would_unblock` semantics, and the auto vs human bucket classification algorithm.

## Where a need lives

A persona that surfaces a need writes it to `/needs/<NN>-<slug>.yml` in the engagement tree, where `<NN>-<slug>` matches the persona's cell directory. Written via `sec_fs_write` on the append-only `security_files` path. New v1 path prefix: `/needs/`.

The `sec_fs_write` server-side path-scope check allows a persona to write to `/needs/<NN>-<slug>.yml` whose slug matches its own cell dir, matching the base design's "path prefix IS the write claim" rule.

The pivot-coordinator reads every `/needs/*.yml` file via `sec_fs_list prefix=/needs/` + `sec_fs_read`.

## `needs.yml` schema

Normative.

```yaml
schema_version: 1                  # integer, MUST be 1
persona: <persona id>
cell: <cell ordinal, matches parent cell>
iteration: <int>                   # 1 on first write; 2 if a resumed persona appends
generated_at: <iso8601 UTC>
needs:
  - id: <string>                   # unique per persona (e.g. "n-dast-admin-session")
    kind: credential | session | scope-expansion | test-data | tool-auth | other
    urgency: high | medium | low
    would_unblock:
      findings_advanced: [<finding id>, ...]    # ids from this persona's state doc
      hypotheses_testable: [<hypothesis id>, ...]  # informal; not in state doc schema
      surface_added: [<url or endpoint>, ...]   # what becomes reachable if resolved
    detected_from:
      - file: <path>               # where the need was inferred (source cite)
        line: <int or null>
        excerpt: <string>          # one-line quote or summary
    proposed_resolution:
      auto:
        pattern: <string>          # one of the auto-catalog names (Part 05)
        params: {}                 # pattern-specific parameters
      human:
        ask: <string>              # one-paragraph plain-English ask
        example: <string>          # example of expected input
```

**Field semantics.**

- **`id`.** Unique within the persona. Format: `n-<persona>-<short-slug>`. The pivot-coordinator uses this id to track resolution and to stamp `traces_to.pivot_need` on delta findings.
- **`kind`.** One of six categories (§4.2). Determines which auto-catalog patterns MAY apply.
- **`urgency`.** Informative. The coordinator prioritizes high-urgency needs in `human_setup_ask.md` order.
- **`would_unblock.findings_advanced`.** Finding ids from THIS persona's state doc that are currently SPECULATIVE or blocked and would become confirmable if the need is resolved. Example: dast recorded `F-dast-3` as SPECULATIVE with body "403 Forbidden, cannot verify IDOR without admin session". Resolving the need moves this finding to CONFIRMED after re-test.
- **`would_unblock.hypotheses_testable`.** Informal ids (not in the state doc schema). Personas may track them in notes or logs.
- **`would_unblock.surface_added`.** URLs, endpoints, or hosts that become reachable. Normative input to `compute_delta_targets` (Part 05 §5.4).
- **`detected_from`.** Where the persona inferred this need. Informative for the human ask.
- **`proposed_resolution.auto.pattern`.** Empty string OR one of `create-test-account | propagate-session | scope-auto-include | tool-auth-reuse | rerun-with-existing-loot`. See Part 05 §5.5-5.10.
- **`proposed_resolution.human.ask`.** Free-text prompt for the human. Empty string when only `auto` applies.

**Example (dast persona needs an admin session):**
```yaml
schema_version: 1
persona: dast
cell: 2
iteration: 1
generated_at: 2026-08-31T15:10:00Z
needs:
  - id: n-dast-admin-session
    kind: session
    urgency: high
    would_unblock:
      findings_advanced: [F-dast-3]
      hypotheses_testable: [h-dast-privilege-escalation]
      surface_added: ["https://api.example.com/admin/*"]
    detected_from:
      - file: src/routes/admin.py
        line: 12
        excerpt: "@app.route('/admin/users', methods=['GET']) @require_admin"
    proposed_resolution:
      auto:
        pattern: ""
        params: {}
      human:
        ask: "Provide credentials for an admin user on api.example.com. dast discovered admin-only endpoints (/admin/users, /admin/settings) but lacks authentication. With admin credentials, dast can test for IDOR, privilege escalation, and mass assignment."
        example: "username: admin@example.com, password: SecureP@ss123"
```

## Need kinds

Six kinds. Each maps to zero or more auto-catalog patterns (Part 05).

### credential

**Definition.** The persona needs a username and password (or API key, token, ...) to authenticate.

**Auto-patterns:** `create-test-account` (L4), `propagate-session` (L3, when the coordinator already holds a session from that credential in `/loot/catalog.yml`).

**Example.** fuzz discovers a `/signup` endpoint. Writes `kind: credential`, `auto.pattern: create-test-account`, `params: {signup_url: "https://api.example.com/signup"}`.

### session

**Definition.** The persona needs an authenticated HTTP session (cookies, tokens) to access protected surface.

**Auto-patterns:** `propagate-session` (L3), `rerun-with-existing-loot` (L3).

**Example.** dast finds `/admin/*` returns 403. Writes `kind: session`, `auto.pattern: propagate-session`, `params: {source_session_id: <known session id or empty>}` and a `human.ask` for admin credentials as fallback.

### scope-expansion

**Definition.** The persona discovered a host or CIDR outside the original `authorized_scope.hosts` but wants to test it.

**Auto-patterns:** `scope-auto-include` (L3).

**Example.** dast enumerates DNS, finds `staging.example.com`. Writes `kind: scope-expansion`, `auto.pattern: scope-auto-include`, `params: {host: "staging.example.com", discovered_ip: "10.1.2.3"}`. The coordinator checks if `10.1.2.3` sits in `authorized_cidrs` (Part 05 §5.5) and auto-approves iff yes.

### test-data

**Definition.** The persona needs structured data to test an endpoint (test credit card, test SSN, test file).

**Auto-patterns:** none in v1. Every test-data need goes to the human bucket.

**Example.** fuzz finds `/api/v1/payment`. Writes `kind: test-data`, `human.ask: "Provide a test credit card for payment fuzzing"`, `human.example: "card_number: 4242424242424242, cvv: 123, expiry: 12/28"`.

### tool-auth

**Definition.** The persona needs an authentication blob for an external tool (a nuclei paid-templates API key, a Burp Suite Pro license, an OAuth token for a specific SaaS).

**Auto-patterns:** `tool-auth-reuse` (L4, when the coordinator holds an auth blob from a prior engagement in a shared loot store; v1 does not implement cross-engagement loot reuse, see Appendix C §C.6).

**Example.** dast requests nuclei Pro templates for CVE coverage. Writes `kind: tool-auth`, `auto.pattern: tool-auth-reuse`, `params: {tool: "nuclei"}`, and a `human.ask` fallback.

### other

**Definition.** Catch-all. The need does not fit the five categories above.

**Auto-patterns:** none. Every `other` need goes to the human bucket.

**Example.** A persona needs a manual code review of obfuscated JavaScript. Writes `kind: other`, `human.ask: "<description>"`.

## `would_unblock` semantics

The three sub-fields carry different signals for different personas. Only `surface_added` is normative for `delta_targets` (Part 05 §5.4). The other two are informative for the coordinator's priority ordering.

**`findings_advanced`.** Fingerprints of findings the persona already recorded but could not confirm. When the coordinator resolves the need, these findings become the FIRST targets for the delta re-run.

**`hypotheses_testable`.** Informal ideas the persona kept in its state doc log. Not normative; not part of the `security_findings` row set.

**`surface_added`.** URLs, endpoints, hosts. Feeds `delta_targets.authed_surface` and `delta_targets.new_hosts`.

## Classification algorithm

The pivot-coordinator (Part 05 §5.2) classifies every need into one of three buckets: `auto`, `human`, or `deferred`. v1 collapses `deferred` into `human` (multi-round pivots are v2, Appendix C §C.1).

**Pseudocode (pure, normative):**

```python
AUTO_CATALOG = {
    "scope-auto-include",
    "propagate-session",
    "rerun-with-existing-loot",
    "create-test-account",       # L4
    "tool-auth-reuse",            # L4
}

def classify_need(need, ctx):
    """
    need: dict per §4.1
    ctx: {
      "authorized_cidrs": [str, ...],
      "loot": { "sessions": [...], "credentials": [...], "test_data": [...], "tool_auth": [...] },
      "level": int,  # 0..4 (see Part 00, Appendix D)
    }
    Returns one of: "auto", "human", "deferred", "invalid".
    """
    resolution = need.get("proposed_resolution", {})
    auto = resolution.get("auto", {})
    human = resolution.get("human", {})

    pattern = auto.get("pattern") or ""
    params = auto.get("params") or {}

    if pattern in AUTO_CATALOG:
        # L2 does NOT execute auto patterns; every need still goes to human.
        if ctx["level"] < 3:
            if human.get("ask"):
                return "human"
            return "invalid"
        # L3+: check the pattern is available at this level and params resolve.
        if pattern in {"create-test-account", "tool-auth-reuse"} and ctx["level"] < 4:
            if human.get("ask"):
                return "human"
            return "invalid"
        if can_resolve_params(pattern, params, ctx):
            return "auto"

    if human.get("ask"):
        return "human"

    return "invalid"


def can_resolve_params(pattern, params, ctx):
    if pattern == "scope-auto-include":
        return "host" in params and "discovered_ip" in params
    if pattern == "propagate-session":
        sid = params.get("source_session_id", "")
        return any(s["id"] == sid for s in ctx["loot"]["sessions"])
    if pattern == "rerun-with-existing-loot":
        ids = params.get("loot_ids", [])
        seen = {s["id"] for s in ctx["loot"]["sessions"]} \
             | {c["id"] for c in ctx["loot"]["credentials"]} \
             | {t["id"] for t in ctx["loot"]["test_data"]} \
             | {a["id"] for a in ctx["loot"]["tool_auth"]}
        return len(ids) > 0 and all(i in seen for i in ids)
    if pattern == "create-test-account":
        return "signup_url" in params
    if pattern == "tool-auth-reuse":
        return "tool" in params
    return False
```

**Bucket semantics.**

- **`auto`.** Coordinator executes the pattern in resolve mode. On success: write loot entries, record `outcome: ok` in `auto-setups.log`. On failure: `outcome: failed`, need falls back to the human bucket for the same round.
- **`human`.** Coordinator writes a section to `human_setup_ask.md`. The human answers via the web UI or a `human_response.yml` write; resolve mode reads the response.
- **`deferred`.** v1 collapses this to `human`. v2 (multi-round pivots) will re-evaluate the need on the next round once its `blocked_by` list resolves.
- **`invalid`.** The need is malformed. Coordinator logs an error and skips.

## Test vectors

Appendix D §D.3 pins 5 classification vectors. Every classification vector is level-tagged. An L2 implementation MUST pass every L2 vector; an L3 implementation MUST also pass every L3 vector.

## Conformance

**L0.** No needs schema in the runtime data path. Classification IS a pure function; L0 vectors (§D.3, `classify-001`, `classify-002`, `classify-005`) verify the algorithm returns the right bucket.

**L1.** Same as L0.

**L2.** Personas MUST write `/needs/<NN>-<slug>.yml`. The coordinator persona MUST read every `/needs/*.yml` and classify. The coordinator MUST write `human_setup_ask.md`. Auto-catalog execution is NOT required.

**L3.** The coordinator MUST execute the three L3 auto-catalog patterns (`scope-auto-include`, `propagate-session`, `rerun-with-existing-loot`). See Part 05.

**L4.** The coordinator MUST also execute `create-test-account` and `tool-auth-reuse`.
