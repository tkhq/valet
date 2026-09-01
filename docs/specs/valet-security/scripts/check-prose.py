#!/usr/bin/env python3
"""STE-flavored prose check for the Valet Security spec.

Rules per CLAUDE.md and the user global rule "No use of em dashes":
- em-dashes (U+2014) and en-dashes (U+2013) BLOCK. Repo lint hard-fails.
- long sentences WARN. STE strict says 20 words per instruction and 25 per
  description, but per CLAUDE.md specs are STE-FLAVORED, not strict.
  We report but do NOT fail on length.

Usage:
    python3 check-prose.py <file.md> [<file.md> ...]

Exit code:
    0 if no em/en-dash found in any file (warnings do not affect exit).
    1 if any em/en-dash found OR any file cannot be read.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

EM_DASH = "—"
EN_DASH = "–"
DASH_CHARS = (EM_DASH, EN_DASH)

# Long-sentence warning threshold. See CLAUDE.md STE section.
SENTENCE_WARN_WORDS = 40  # generous; spec prose is descriptive


def find_dashes(path: Path) -> list[tuple[int, int, str]]:
    """Return [(line_no, col_no, dash_char), ...] for every dash in the file.

    Skips lines inside fenced code blocks (```) since code samples may have
    literal em-dashes in string literals or comments.
    """
    hits: list[tuple[int, int, str]] = []
    in_fence = False
    for i, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        stripped = line.lstrip()
        if stripped.startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        for j, ch in enumerate(line, start=1):
            if ch in DASH_CHARS:
                hits.append((i, j, ch))
    return hits


_SENTENCE_END = re.compile(r"[.!?](?:\s|$)")


def _wc(sentence: str) -> int:
    words = re.findall(r"\S+", sentence)
    return len(words)


def find_long_sentences(path: Path) -> list[tuple[int, int, str]]:
    """Return [(line_no, word_count, sentence_prefix), ...] for sentences
    longer than SENTENCE_WARN_WORDS. Sentence detection is coarse: split
    on . ! ? boundaries within markdown paragraphs, skip code fences,
    skip lines starting with |, #, -, *, `, or number+dot (list markers).
    """
    warnings: list[tuple[int, int, str]] = []
    in_fence = False
    buffer_start = 0
    buffer_text: list[str] = []
    for i, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        stripped = line.lstrip()
        if stripped.startswith("```"):
            in_fence = not in_fence
            # flush and reset
            _flush_paragraph(buffer_start, buffer_text, warnings)
            buffer_text = []
            continue
        if in_fence:
            continue
        skip = (
            not stripped
            or stripped.startswith("#")
            or stripped.startswith("|")
            or stripped.startswith("- ")
            or stripped.startswith("* ")
            or stripped.startswith("> ")
            or stripped.startswith("`")
            or re.match(r"^\d+\.", stripped)
        )
        if skip:
            _flush_paragraph(buffer_start, buffer_text, warnings)
            buffer_text = []
            continue
        if not buffer_text:
            buffer_start = i
        buffer_text.append(line)
    _flush_paragraph(buffer_start, buffer_text, warnings)
    return warnings


def _flush_paragraph(
    start_line: int, lines: list[str], warnings: list[tuple[int, int, str]]
) -> None:
    text = " ".join(lines).strip()
    if not text:
        return
    sentences = _SENTENCE_END.split(text)
    for sentence in sentences:
        sentence = sentence.strip()
        if not sentence:
            continue
        wc = _wc(sentence)
        if wc > SENTENCE_WARN_WORDS:
            preview = sentence[:80] + ("..." if len(sentence) > 80 else "")
            warnings.append((start_line, wc, preview))


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("usage: check-prose.py <file.md> [<file.md> ...]", file=sys.stderr)
        return 2

    exit_code = 0
    total_dashes = 0
    total_warnings = 0

    for arg in argv[1:]:
        path = Path(arg)
        if not path.is_file():
            print(f"ERROR: {arg} not a file", file=sys.stderr)
            exit_code = 1
            continue
        try:
            dashes = find_dashes(path)
        except Exception as e:
            print(f"ERROR: cannot read {arg}: {e}", file=sys.stderr)
            exit_code = 1
            continue

        for line_no, col, ch in dashes:
            name = "em-dash" if ch == EM_DASH else "en-dash"
            print(f"FAIL {path}:{line_no}:{col}: {name} (U+{ord(ch):04X})")
            total_dashes += 1

        warnings = find_long_sentences(path)
        for line_no, wc, preview in warnings:
            print(f"WARN {path}:{line_no}: sentence {wc} words > {SENTENCE_WARN_WORDS}: {preview}")
            total_warnings += 1

    if total_dashes:
        exit_code = 1
        print(f"\nem-dash / en-dash count: {total_dashes} (BLOCKS)")
    if total_warnings:
        print(f"long-sentence count: {total_warnings} (WARN, does not block)")
    if not total_dashes and not total_warnings:
        print("check-prose: clean")

    return exit_code


if __name__ == "__main__":
    sys.exit(main(sys.argv))
