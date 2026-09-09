#!/usr/bin/env python3
"""Fail a PR that reintroduces a native browser dialog into the web app.
Walks packages/web/src and reports every occurrence; there is no PR body to
read and no diff to compute.

The rule: a destructive action confirms through the ConfirmDialog primitive
(packages/web/src/components/primitives/confirm-dialog.tsx), never through
`confirm()`. Native confirm cannot show pending state or the server error a
failed mutation returns, it ignores the app's theme, and browser automation
auto-accepts it — so for an agent or a scripted client it is not a
confirmation step at all. Thirteen call sites were converted on 2026-09-08;
this guards the class.

The invariant is zero occurrences, so the whole tree is scanned rather than
the PR's diff. A whole-tree scan also catches a file that moves in without
changing. Test files are exempt: a test asserts on the old behavior or
stubs the global. The primitive itself is exempt: its doc comment names
what it replaces.

Usage:
    python3 scripts/ci/confirm_dialog_guard.py
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
WEB = REPO / "packages" / "web" / "src"
PRIMITIVE = ("components", "primitives", "confirm-dialog.tsx")
SOURCE_SUFFIXES = (".ts", ".tsx", ".js", ".jsx")
TEST_SUFFIXES = (".test.ts", ".test.tsx", ".test.js", ".test.jsx")
# `confirm(`, or the same call through a global object. `alert` and `prompt`
# are in the same class and carry the same three faults, so the guard names
# all three rather than waiting for the next one to land.
CALL = re.compile(r"(?<![\w$.])(?:(?:window|globalThis|self)\s*\.\s*)?(?:confirm|alert|prompt)\s*\(")

# A line whose first non-space character opens or continues a comment, skipped
# before the match runs. This product's own vocabulary is full of the word
# "prompt", and a doc comment reading "the refute-reason prompt (r)" satisfies
# `prompt\s*\(` exactly; a guard that cries wolf on prose gets switched off. A
# trailing comment after code is deliberately NOT skipped: erring toward a
# report is safe there, erring toward silence is not.
COMMENT_LINE = re.compile(r"\s*(?://|/\*|\*)")

FIX = (
    "Confirm the action with the ConfirmDialog primitive from "
    "~/components/primitives.\n"
    "The button's onClick opens the dialog; the dialog's onConfirm runs the "
    "mutation, with `pending` and `error` wired from it.\n"
    "Native confirm() cannot show pending state or a server error, and "
    "browser automation auto-accepts it, so an agent client gets no "
    "confirmation step at all.\n"
    "Model: packages/web/src/components/settings/teams-panel.tsx.\n"
)


def scan(root: Path) -> list[str]:
    """Return one `path:line: text` report per occurrence under `root`."""
    found = []
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.suffix not in SOURCE_SUFFIXES:
            continue
        if path.name.endswith(TEST_SUFFIXES):
            continue
        if path.parts[-len(PRIMITIVE) :] == PRIMITIVE:
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        for number, line in enumerate(text.splitlines(), start=1):
            if COMMENT_LINE.match(line):
                continue
            if CALL.search(line):
                rel = path.relative_to(REPO) if path.is_relative_to(REPO) else path
                found.append(f"{rel}:{number}: {line.strip()}")
    return found


def main() -> int:
    if not WEB.is_dir():
        # Never pass by scanning nothing: a moved tree needs this path fixed.
        sys.stderr.write(f"{WEB} not found. Update WEB in {Path(__file__).name}.\n")
        return 1
    found = scan(WEB)
    if found:
        sys.stderr.write(f"Native browser dialog in the web app ({len(found)}):\n")
        for report in found:
            sys.stderr.write(f"  {report}\n")
        sys.stderr.write("\n" + FIX)
        return 1
    print("confirm-dialog guard: ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
