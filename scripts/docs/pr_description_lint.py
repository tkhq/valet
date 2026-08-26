#!/usr/bin/env python3
"""Deterministic lint for PR descriptions. Reads the PR body from stdin and
exits 1 when the body breaks a hard rule.

Hard rules:
  1. The body must not be empty.
  2. No em dashes or en dashes.
  3. At most MAX_WORDS words (fenced code blocks excluded).
  4. No marketing adjectives (list vendored in ste_lint.py).
  5. No modal hedges ("it is worth noting", "please note that", ...).
  6. A non-empty Validation section (see .github/PULL_REQUEST_TEMPLATE.md).
     Accepted heading names: Validation, Test plan, Tests, Testing,
     Verification.

HTML comments are stripped before every check: they do not render on the PR,
so the template's instruction comments never count against the rules.

Everything else the STE linter reports (passive voice, banned words, long
sentences) prints as advisory context and does not fail the check. Those
signals have false positives; the hard rules above do not.

Usage:
  printf '%s' "$PR_BODY" | python3 scripts/docs/pr_description_lint.py
  python3 scripts/docs/pr_description_lint.py --max-words 400 < body.md
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ste_lint import (  # noqa: E402
    MARKETING,
    MODAL_HEDGE,
    count_phrases,
    lint,
    sentences,
    strip_code,
    word_count,
)

MAX_WORDS = 300
COMMENT = re.compile(r"<!--.*?-->", re.S)
VALIDATION_HEADING = re.compile(
    r"^#{2,4}\s*(?:validation|test plan|tests|testing|verification)\b.*$",
    re.I | re.M,
)
ANY_HEADING = re.compile(r"^#{1,4}\s", re.M)


def validation_section(body: str) -> str | None:
    """Return the text under the Validation heading, or None if absent."""
    match = VALIDATION_HEADING.search(body)
    if not match:
        return None
    rest = body[match.end():]
    next_heading = ANY_HEADING.search(rest)
    return rest[: next_heading.start()] if next_heading else rest


def check(body: str, max_words: int) -> list[str]:
    failures: list[str] = []

    body = COMMENT.sub(" ", body)
    if not body.strip():
        failures.append(
            "The PR description is empty. Describe what changed and how you "
            "tested it."
        )
        return failures

    # Count on code-stripped text: pasted command output in a test plan can
    # contain dashes the author did not write.
    prose = strip_code(body)
    dashes = prose.count("—") + prose.count("–")
    if dashes:
        failures.append(
            f"Found {dashes} em/en dash(es). Replace each one with a period, "
            "comma, colon, or parentheses."
        )
    words = sum(word_count(sentence) for sentence in sentences(prose))
    if words > max_words:
        failures.append(
            f"The description is {words} words; the limit is {max_words}. "
            "Cut it down. Move long detail into code comments, the spec, or "
            "the linked issue."
        )

    marketing_count, marketing_hits = count_phrases(prose, MARKETING)
    if marketing_count:
        unique = ", ".join(dict.fromkeys(marketing_hits))
        failures.append(
            f"Found marketing words: {unique}. Remove them; state what the "
            "change does instead."
        )

    hedge_count, hedge_hits = count_phrases(prose, MODAL_HEDGE)
    if hedge_count:
        unique = ", ".join(dict.fromkeys(hedge_hits))
        failures.append(
            f"Found filler hedges: {unique}. Delete the hedge and keep the "
            "fact."
        )

    section = validation_section(body)
    if section is None:
        failures.append(
            "No Validation section. Add '## Validation' with the commands "
            "you ran and their results."
        )
    elif not re.search(r"\w", section):
        failures.append(
            "The Validation section is empty. State the commands you ran "
            "and their results."
        )

    return failures


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--max-words", type=int, default=MAX_WORDS)
    arguments = parser.parse_args()

    body = sys.stdin.read()
    failures = check(body, arguments.max_words)

    if failures:
        print("PR description lint FAILED:\n")
        for index, failure in enumerate(failures, 1):
            print(f"  {index}. {failure}")
        print(
            "\nRules: no em dashes, no marketing words, no filler hedges, "
            f"{arguments.max_words} words max, a filled-in Validation "
            "section. See CLAUDE.md 'Writing'."
        )
        return 1

    report = lint(body)
    print(
        f"PR description lint ok: {report['words']} words, "
        f"advisory STE score {report['total_per100w']}/100w."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
