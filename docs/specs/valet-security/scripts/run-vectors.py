#!/usr/bin/env python3
"""Conformance runner for the Valet Security spec vectors.

Reads every JSON file under docs/specs/valet-security/vectors/, filters by
`--level`, dispatches by FILENAME to the reference implementation function,
and prints a per-vector pass/fail line. Exits 0 iff every relevant vector
passes.

Level filter maps L0..L4 to integers 0..4 and compares INTEGERS. String
comparison silently skips lower-level vectors on a higher-level run; that
is a runner bug. See Appendix D sec D.6.

Dispatch is by FILENAME, not by the shape of `expected`. See Appendix D
for the binding.

Usage:
    python3 run-vectors.py --impl <impl-dir> --level L0
    python3 run-vectors.py --impl <impl-dir> --level L4 --vectors-dir docs/specs/valet-security/vectors
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path
from typing import Any


LEVEL_MAP = {"L0": 0, "L1": 1, "L2": 2, "L3": 3, "L4": 4}


def _load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None, f"cannot load {path}"
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def dispatch(
    vector_file: Path,
    vec: dict[str, Any],
    impl_root: Path,
) -> tuple[bool, str]:
    """Return (passed, message). Route by vector filename."""
    name = vector_file.name

    if name == "fingerprints.json":
        fp = _load_module("fp", impl_root / "fingerprint.py")
        inp = vec["input"]
        actual = fp.fingerprint_hex(inp["file"], inp["line"], inp["title"], inp["body"])
        expected = vec["expected"]["fingerprint"]
        return (actual == expected, f"expected={expected} actual={actual}")

    if name == "needs-classification.json":
        nd = _load_module("nd", impl_root / "needs.py")
        inp = vec["input"]
        actual = nd.classify_need(inp["need"], inp["ctx"])
        expected = vec["expected"]["bucket"]
        return (actual == expected, f"expected={expected} actual={actual}")

    if name == "delta-targets.json":
        dt = _load_module("dt", impl_root / "delta_targets.py")
        inp = vec["input"]
        actual = dt.compute_delta_targets(inp["persona"], inp["resolved_needs"], inp["loot"])
        expected = vec["expected"]["delta_targets"]
        return (actual == expected, f"expected={expected} actual={actual}")

    if name == "auto-catalog.json":
        ac = _load_module("ac", impl_root / "auto_catalog.py")
        inp = vec["input"]
        actual = ac.execute_pattern(inp["pattern"], inp["need_id"], inp["params"], inp["ctx"])
        expected = vec["expected"]
        # Compare shape-tolerantly: every key in `expected` must match in `actual`.
        diffs = []
        for key, value in expected.items():
            if actual.get(key) != value:
                diffs.append(f"{key}: expected={value} actual={actual.get(key)}")
        if diffs:
            return (False, "; ".join(diffs))
        return (True, "ok")

    if name == "anti-cap.json":
        an = _load_module("an", impl_root / "anti_cap.py")
        inp = vec["input"]
        check = vec["check"]
        if check == "finding-count-monotonicity":
            actual = an.check_finding_count_monotonicity(inp["prior_state"], inp["new_state"])
        elif check == "pivot-need-citation":
            actual = an.check_pivot_need_citation(
                inp["prior_state"], inp["new_state"], inp["findings_files"]
            )
        else:
            return (False, f"unknown check {check!r}")
        expected = vec["expected"]
        # Compare shape-tolerantly.
        diffs = []
        for key, value in expected.items():
            if actual.get(key) != value:
                diffs.append(f"{key}: expected={value} actual={actual.get(key)}")
        if diffs:
            return (False, "; ".join(diffs))
        return (True, "ok")

    return (False, f"unknown vector file: {name}")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--impl", required=True, help="Reference implementation directory.")
    parser.add_argument("--level", required=True, choices=list(LEVEL_MAP))
    parser.add_argument(
        "--vectors-dir",
        default=str(Path(__file__).resolve().parent.parent / "vectors"),
    )
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args(argv[1:])

    target = LEVEL_MAP[args.level]
    impl_root = Path(args.impl)
    if not impl_root.is_dir():
        print(f"ERROR: --impl {args.impl} not a directory", file=sys.stderr)
        return 2

    vectors_dir = Path(args.vectors_dir)
    if not vectors_dir.is_dir():
        print(f"ERROR: --vectors-dir {args.vectors_dir} not a directory", file=sys.stderr)
        return 2

    passed = 0
    failed = 0
    skipped = 0

    for vector_file in sorted(vectors_dir.glob("*.json")):
        try:
            data = json.loads(vector_file.read_text(encoding="utf-8"))
        except Exception as e:
            print(f"ERROR: cannot parse {vector_file.name}: {e}", file=sys.stderr)
            failed += 1
            continue
        for vec in data:
            level = LEVEL_MAP.get(vec.get("level", "L0"))
            if level is None or level > target:
                skipped += 1
                continue
            try:
                ok, msg = dispatch(vector_file, vec, impl_root)
            except Exception as e:
                ok = False
                msg = f"exception: {type(e).__name__}: {e}"
            if ok:
                passed += 1
                if args.verbose:
                    print(f"PASS {vector_file.name}:{vec['id']}")
            else:
                failed += 1
                print(f"FAIL {vector_file.name}:{vec['id']}: {msg}")

    print(f"\npassed={passed} failed={failed} skipped={skipped} target_level={args.level}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
