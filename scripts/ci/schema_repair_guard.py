#!/usr/bin/env python3
"""Fail a PR that edits the app migration in place without a matching schema
repair. Reads the PR's changed file list from stdin (one path per line) and the
PR body from $PR_BODY.

The rule (CLAUDE.md "Pre-1.0: edit migrations in place"): an edit to
packages/api/migrations/pg/0000_app.sql that adds a nullable/DEFAULT column, a
table, or an index needs a matching SCHEMA_REPAIRS entry in
packages/api/src/lib/drizzle.ts, or an already-migrated database never gets the
change and the rollout sticks on the old image. Two schema-repair misses have
reached a deploy, so this guards the class.

The check is a heuristic: it fires when 0000_app.sql changed but drizzle.ts did
not. Some edits legitimately need no repair (a comment, or a change that needs a
real migration rather than a repair). Acknowledge those with a line in the PR
body:

    no-schema-repair: <reason>

Usage:
    git diff --name-only "$BASE...$HEAD" | PR_BODY="$BODY" python3 scripts/ci/schema_repair_guard.py
"""
from __future__ import annotations

import os
import re
import sys

MIGRATION = "packages/api/migrations/pg/0000_app.sql"
REPAIRS = "packages/api/src/lib/drizzle.ts"
# A line like "no-schema-repair: comment-only edit". The reason is required, so a
# bare "no-schema-repair:" does not pass. HTML comments are stripped first so a
# template hint does not count.
COMMENT = re.compile(r"<!--.*?-->", re.S)
OVERRIDE = re.compile(r"^\s*no-schema-repair:\s*\S", re.I | re.M)


def check(changed: set[str], body: str) -> str | None:
    """Return an error message when the rule is broken, else None."""
    if MIGRATION not in changed:
        return None
    if REPAIRS in changed:
        return None
    if OVERRIDE.search(COMMENT.sub(" ", body)):
        return None
    return (
        f"{MIGRATION} was edited but {REPAIRS} was not.\n"
        "An in-place app-migration edit that adds a nullable/DEFAULT column, a "
        "table, or an index needs a matching SCHEMA_REPAIRS entry in "
        f"{REPAIRS}, or a deployed database never gets it and the rollout sticks "
        "on the old image.\n"
        "Add the repair entry, or if this edit needs none, add a line to the PR "
        "description:\n"
        "    no-schema-repair: <reason>\n"
    )


def main() -> int:
    changed = {line.strip() for line in sys.stdin if line.strip()}
    error = check(changed, os.environ.get("PR_BODY", ""))
    if error:
        sys.stderr.write(error)
        return 1
    print("schema-repair guard: ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
