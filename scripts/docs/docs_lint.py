#!/usr/bin/env python3
"""Advisory STE lint over the repo's maintained prose (CLAUDE.md Writing
section). Runs the vendored heuristic linter (scripts/docs/ste_lint.py)
over the curated file list and fails when a file exceeds its violation
threshold (violations per 100 words).

The linter is diagnostic, not certification: quoted example words, code
identifiers, and possessives produce false positives, so the thresholds
carry headroom over the current scores. When you improve a file well below
its threshold, tighten the threshold in the same commit.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
LINTER = Path(__file__).resolve().parent / "ste_lint.py"

# file → max violations per 100 words. Curated: the runbooks, docs guides,
# and package READMEs that went through the 2026-07-29 STE pass. Specs are
# deliberately absent (rules apply on touch, not wholesale).
THRESHOLDS = {
    "README.md": 4.0,
    "CLAUDE.md": 6.0,
    "deploy/README.md": 4.0,
    "deploy/chart/valet/README.md": 4.5,
    "docs/cli.md": 4.0,
    "docs/architecture.md": 4.5,
    "docs/kubernetes.md": 4.5,
    "docs/security-model.md": 5.0,
    "docs/environment-variables.md": 3.5,
    "docs/api-reference.md": 4.0,
    "packages/engine/README.md": 3.5,
    "packages/api/README.md": 4.5,
    "packages/web/README.md": 3.0,
}


def score(path: Path) -> float:
    out = subprocess.run(
        [sys.executable, str(LINTER)],
        input=path.read_text(),
        capture_output=True,
        text=True,
        check=True,
    )
    data = json.loads(out.stdout)
    words = max(1, data["words"])
    total = sum(data["violations"].values())
    return round(total * 100 / words, 2)


def main() -> int:
    failures = []
    for rel, limit in sorted(THRESHOLDS.items()):
        path = REPO / rel
        if not path.exists():
            failures.append(f"{rel}: file missing (update THRESHOLDS)")
            continue
        s = score(path)
        status = "ok  " if s <= limit else "FAIL"
        print(f"{status} {rel:45s} {s:5.2f} / limit {limit}")
        if s > limit:
            failures.append(f"{rel}: {s} > {limit}")
    if failures:
        print("\ndocs-lint failures (see CLAUDE.md 'Writing'):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("\nAll maintained prose within thresholds.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
