# Appendix D: Test Vectors

*Normative. Conformance: L0+.*

This appendix defines the JSON test vectors that pin every normative decision function in this spec. The vectors ship as data files under `docs/specs/valet-security/vectors/`. The conformance runner (`docs/specs/valet-security/scripts/run-vectors.py`) reads every file, filters by requested level, dispatches by filename to the reference implementation, and exits 0 iff every match passes.

## Purpose

Test vectors serve three purposes:

1. **Byte-for-byte agreement.** Two conformant implementations of the L0 kernel produce identical output for identical input.
2. **Regression detection.** If an implementation changes and any vector fails, the change is non-conformant.
3. **Executable documentation.** Vectors show one concrete example of every normative algorithm.

Every vector is tagged with its conformance level (`L0`, `L1`, `L2`, `L3`, or `L4`). An implementation at level N MUST pass every vector tagged N or lower.

## Level filter (int-mapped)

Levels compare as INTEGERS, not strings. The runner MUST map:

```
L0 → 0
L1 → 1
L2 → 2
L3 → 3
L4 → 4
```

**Correct:**
```python
LEVEL_MAP = {"L0": 0, "L1": 1, "L2": 2, "L3": 3, "L4": 4}

def run_vectors(level_str: str) -> int:
    target = LEVEL_MAP[level_str]
    for vec in load_all():
        if LEVEL_MAP[vec["level"]] > target:
            continue
        # ... dispatch ...
```

**Wrong:**
- `vec["level"] not in ["L0", my_level]` (an L3 run silently skips L1, L2 vectors).
- `vec["level"] > level` (string comparison; `"L10"` would beat `"L2"`).

## Runner dispatch by FILENAME

The runner dispatches to a reference function based on the vector FILE NAME, not the shape of `expected`. Every file binds normatively to one function.

| File | Function under test | Level tag on every vector |
|---|---|---|
| `vectors/fingerprints.json` | `fingerprint(file, line, title, body)` | `L0` |
| `vectors/needs-classification.json` | `classify_need(need, ctx)` | `L2` or `L3` |
| `vectors/delta-targets.json` | `compute_delta_targets(persona, resolved_needs, loot)` | `L3` |
| `vectors/auto-catalog.json` | `execute_pattern(pattern, params, ctx)` | `L3` |
| `vectors/anti-cap.json` | `check_finding_count_monotonicity(...)` OR `check_pivot_need_citation(...)` | `L4` |

The `anti-cap.json` file mixes both anti-cap checks. Vectors carry a `check` field naming which function to call.

## Vector file format

Every JSON file contains an array of vectors. Every vector carries:

- `id` (string): unique identifier (e.g. `finding-001`, `delta-targets-001`).
- `level` (string): conformance level.
- `description` (string, optional): human-readable one-liner.
- `input` (object): input for the reference function.
- `expected` (object): expected return value.

## D.1 Finding fingerprints

**File:** `vectors/fingerprints.json`.
**Level:** `L0`.
**Function under test:** `fingerprint(file, line, title, body) -> bytes[20]` (Part 02 §2.2).

The file carries 13 vectors, one per finding in the acceptance scenario (Appendix A). Every vector pins `expected.fingerprint` as a 40-character lowercase hex string.

**Vector ids (bound to Appendix A findings):**

| Vector | Appendix A finding | Persona | File / line |
|---|---|---|---|
| `finding-001` | F-cr-1 | code-review | `config/db.yml:5` |
| `finding-002` | F-sast-1 | sast | `api.py:45` |
| `finding-003` | F-sast-2 | sast | `views.py:78` |
| `finding-004` | F-dast-1 | dast | `open redirect on /public/redirect?url=` (URL fingerprint) |
| `finding-005` | F-dast-2 | dast | `missing CSP header` (repo-scoped) |
| `finding-006` | F-dast-3 | dast | `verbose error messages` (repo-scoped) |
| `finding-007` | F-fuzz-1 | fuzz | `parameter pollution on /api/v1/payment` |
| `finding-008` | F-fuzz-2 | fuzz | `missing rate limit on /api/v1/payment` |
| `finding-009` | F-fuzz-3 | fuzz | `CORS misconfig on /api/v1/payment` |
| `finding-010` | F-dast-4 | dast (delta) | `IDOR on /admin/users?id=` |
| `finding-011` | F-dast-5 | dast (delta) | `staging API on port 443` |
| `finding-012` | F-fuzz-4 | fuzz (delta) | `payment bypass via malformed expiry` |
| `finding-013` | F-fuzz-5 | fuzz (delta) | `integer overflow on payment amount` |

The `expected.fingerprint` value is computed by the reference implementation (`docs/specs/valet-security/reference/fingerprint.py`). If a v1-draft copy of Appendix D shipped placeholder hex, those placeholders are NOT normative; the reference computation is. See the changelog in the README.

**Vector (subset):**

```json
[
  {
    "id": "finding-001",
    "level": "L0",
    "description": "code-review: hardcoded password in config/db.yml",
    "input": {
      "file": "config/db.yml",
      "line": 5,
      "title": "Hardcoded password in database configuration",
      "body": "The file `config/db.yml` line 5 contains a plaintext password: `password: SuperSecret123`. This violates the principle of least privilege and exposes the database to credential theft. Recommendation: use environment variables or a secrets manager (AWS Secrets Manager, HashiCorp Vault) to inject credentials at runtime."
    },
    "expected": {
      "fingerprint": "<computed by reference/fingerprint.py>"
    }
  }
]
```

**Test procedure:**

```python
import json
from reference.fingerprint import fingerprint

with open("vectors/fingerprints.json") as f:
    vectors = json.load(f)

for vec in vectors:
    inp = vec["input"]
    expected = vec["expected"]["fingerprint"]
    actual = fingerprint(inp["file"], inp["line"], inp["title"], inp["body"]).hex()
    assert actual == expected, f"{vec['id']}: expected {expected}, got {actual}"
```

## D.2 delta_targets computation

**File:** `vectors/delta-targets.json`.
**Level:** `L3`.
**Function under test:** `compute_delta_targets(persona, resolved_needs, loot)` (Part 05 §5.4).

The file carries 2 vectors: dast delta re-run, fuzz delta re-run (Appendix A phases 3-4).

**Vector 1 (dast).** Input: 2 resolved needs (`n-dast-admin-session` session, `n-dast-scope-staging` scope-expansion). Loot: 1 admin credential + 1 admin session. Expected: `authed_surface: ["https://api.example.com/admin/*"]`, `new_hosts: ["staging.example.com"]`, `auth_scopes: ["admin"]`, `test_data: []`, `tool_auth: []`.

**Vector 2 (fuzz).** Input: 1 resolved need (`n-fuzz-payment-test-data`). Loot: 1 test-data row (`payment-card`). Expected: `test_data: ["payment-card"]`, every other field empty.

## D.3 Needs classification

**File:** `vectors/needs-classification.json`.
**Level:** `L2` for basic classification, `L3` for auto-catalog params.
**Function under test:** `classify_need(need, ctx) -> "auto" | "human" | "deferred"` (Part 04 §4.3).

5 vectors covering auto and human buckets across L2/L3.

**Vector 1 (`classify-001`, L2, auto bucket).** `scope-auto-include` with IP in CIDR.

**Vector 2 (`classify-002`, L2, human bucket).** `test-data` with no auto pattern.

**Vector 3 (`classify-003`, L3, auto bucket).** `propagate-session` with source_session_id in loot.

**Vector 4 (`classify-004`, L3, human bucket).** `propagate-session` with source_session_id NOT in loot; params do not resolve; falls back to human.

**Vector 5 (`classify-005`, L2, human bucket / v2 deferred).** `blocked_by` set; v1 classifies as `human`, v2 as `deferred`.

## D.4 Auto-catalog outcomes

**File:** `vectors/auto-catalog.json`.
**Level:** `L3`.
**Function under test:** `execute_pattern(pattern, params, ctx)` (Part 05 §5.5-5.7).

6 vectors, one success + one failure per pattern:

- `auto-catalog-001`: `scope-auto-include` success (IP in CIDR).
- `auto-catalog-002`: `scope-auto-include` failure (IP not in CIDR).
- `auto-catalog-003`: `propagate-session` success (session exists in loot).
- `auto-catalog-004`: `propagate-session` failure (session not found).
- `auto-catalog-005`: `rerun-with-existing-loot` success (loot ids exist; `authed_surface: ["https://<session.host>/*"]` per the Part 05 §5.7 derivation rule).
- `auto-catalog-006`: `rerun-with-existing-loot` failure (loot ids not found).

## D.5 Anti-cap checks

**File:** `vectors/anti-cap.json`.
**Level:** `L4`.
**Function under test:** `check_finding_count_monotonicity(prior_state, new_state)` and `check_pivot_need_citation(prior_state, new_state, findings_files)` (Part 07 §7.1-7.2).

Every vector carries a `check` field naming which function to call. 4 vectors.

- `anti-cap-001`: monotonicity pass. `new=5 >= prior=3`.
- `anti-cap-002`: monotonicity fail. `new=2 < prior=3`. Expected reason: `"finding-count decreased (prior: 3, new: 2)"`.
- `anti-cap-003`: citation pass. Every new finding has `traces_to.pivot_need` set.
- `anti-cap-004`: citation fail. One new finding has `traces_to: {}`. Expected reason: `"schema violation: finding <id> missing traces_to.pivot_need"`.

## D.6 Runner reference

**File:** `docs/specs/valet-security/scripts/run-vectors.py`.

Skeleton (normative shape):

```python
#!/usr/bin/env python3
"""Conformance runner for the Valet Security spec vectors."""
from __future__ import annotations
import argparse, json, sys
from pathlib import Path

LEVEL_MAP = {"L0": 0, "L1": 1, "L2": 2, "L3": 3, "L4": 4}

def dispatch(vector_file: Path, vec: dict, impl_root: Path) -> tuple[bool, str]:
    """Route by filename. Return (passed, message)."""
    name = vector_file.name
    if name == "fingerprints.json":
        from importlib.util import spec_from_file_location, module_from_spec
        mod_spec = spec_from_file_location("fp", impl_root / "fingerprint.py")
        mod = module_from_spec(mod_spec); mod_spec.loader.exec_module(mod)
        inp = vec["input"]
        actual = mod.fingerprint(inp["file"], inp["line"], inp["title"], inp["body"]).hex()
        expected = vec["expected"]["fingerprint"]
        return (actual == expected, f"expected {expected}, got {actual}")
    if name == "needs-classification.json":
        # ... dispatch classify_need
        ...
    if name == "delta-targets.json":
        # ... dispatch compute_delta_targets
        ...
    if name == "auto-catalog.json":
        # ... dispatch execute_pattern
        ...
    if name == "anti-cap.json":
        # ... dispatch check_* per vec["check"]
        ...
    raise ValueError(f"unknown vector file: {name}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--impl", required=True, help="Path to reference implementation dir.")
    parser.add_argument("--level", required=True, choices=list(LEVEL_MAP.keys()))
    parser.add_argument("--vectors-dir", default="docs/specs/valet-security/vectors")
    args = parser.parse_args()

    target_level = LEVEL_MAP[args.level]
    impl_root = Path(args.impl)
    vectors_dir = Path(args.vectors_dir)

    passed = 0
    failed = 0
    for vector_file in sorted(vectors_dir.glob("*.json")):
        with open(vector_file) as f:
            vectors = json.load(f)
        for vec in vectors:
            if LEVEL_MAP[vec["level"]] > target_level:
                continue
            ok, msg = dispatch(vector_file, vec, impl_root)
            if ok:
                passed += 1
            else:
                failed += 1
                print(f"FAIL {vector_file.name}:{vec['id']}: {msg}")

    print(f"passed={passed} failed={failed} target_level={args.level}")
    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()
```

## Vector file organization

```
docs/specs/valet-security/vectors/
  fingerprints.json          # §D.1, 13 vectors, L0
  needs-classification.json  # §D.3, 5 vectors, L2 or L3
  delta-targets.json         # §D.2, 2 vectors, L3
  auto-catalog.json          # §D.4, 6 vectors, L3
  anti-cap.json              # §D.5, 4 vectors, L4
```

Total: 30 vectors across 5 files.

## Vector update policy

Vectors are normative. If a vector is wrong (expected output does not match the algorithm), the spec is buggy AND the vector must change. Every vector change requires a changelog entry (README §Changelog) naming the affected file and the rationale.

New vectors MAY be added (edge cases discovered in implementation). Existing vectors SHOULD NOT be removed.

The v1-draft copy of Appendix D shipped placeholder hex fingerprints (`a3f5c8e9...b8a0`, `b1c2d3e4...b9c0`, `c2d3e4f5...c0d1`). Those were illustrative, not derived from any algorithm. v1 replaces them with values computed by the reference implementation. No implementation was conformant to the placeholder set (no algorithm produced those values), so no downstream implementation is invalidated by the replacement.
