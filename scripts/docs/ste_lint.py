#!/usr/bin/env python3
"""Report mechanical Simplified Technical English and AI-slop signals."""

from __future__ import annotations

import glob
import json
import os
import re
import sys

MARKETING = [
    "seamless",
    "seamlessly",
    "robust",
    "powerful",
    "cutting-edge",
    "effortless",
    "effortlessly",
    "world-class",
    "next-generation",
    "revolutionary",
    "blazing",
    "lightning-fast",
    "elegant",
    "delightful",
    "turnkey",
    "best-in-class",
    "state-of-the-art",
    "game-changing",
    "first-class",
    "battle-tested",
    "enterprise-grade",
    "supercharge",
    "unlock",
    "unleash",
    "empower",
    "empowers",
]
BANNED = [
    "begin",
    "begins",
    "commence",
    "commences",
    "initiate",
    "initiates",
    "originate",
    "utilize",
    "utilizes",
    "utilizing",
    "leverage",
    "leverages",
    "leveraging",
    "facilitate",
    "facilitates",
    "ensure",
    "ensures",
    "ensuring",
    "prior to",
    "subsequent to",
    "obtain",
    "obtains",
    "acquire",
    "acquires",
    "demonstrate",
    "demonstrates",
    "additionally",
    "furthermore",
    "moreover",
    "comprehensive",
    "comprehensively",
    "utilization",
    "aforementioned",
    "henceforth",
    "therein",
    "whilst",
    "amongst",
    "numerous",
    "myriad",
    "plethora",
    "in order to",
    "a variety of",
    "in the event that",
    "due to the fact that",
    "it is important to note",
]
PHRASAL = [
    "spin up",
    "spin down",
    "reach out",
    "dive into",
    "dives into",
    "diving into",
    "kick off",
    "kicks off",
    "roll out",
    "rolls out",
    "tear down",
    "ramp up",
    "circle back",
    "drill down",
    "spun up",
    "reaching out",
]
MODAL_HEDGE = [
    "it is important to note",
    "it should be noted",
    "it is worth noting",
    "please note that",
    "as mentioned",
    "as noted above",
]
BE = r"(?:am|is|are|was|were|be|been|being)"
IRREGULAR_PARTICIPLE = (
    r"(?:done|made|sent|read|built|kept|held|set|put|run|written|shown|given|"
    r"taken|found|got|gotten|seen|known|thrown|drawn)"
)


def strip_code(text: str) -> str:
    text = re.sub(r"```.*?```", " ", text, flags=re.S)
    return re.sub(r"`[^`]*`", " ", text)


def sentences(text: str) -> list[str]:
    output: list[str] = []
    for line in text.splitlines():
        sentence = line.strip()
        if not sentence:
            continue
        sentence = re.sub(r"^\s*#{1,6}\s*", "", sentence)
        sentence = re.sub(r"^\s*(?:[-*+]|\d+[.)])\s+", "", sentence)
        if not sentence:
            continue
        parts = re.split(r"(?<=[.!?:])\s+(?=[A-Z0-9\"'\-])", sentence)
        output.extend(part.strip() for part in parts if part.strip())
    return output


def word_count(text: str) -> int:
    return len(re.findall(r"[A-Za-z0-9][A-Za-z0-9'\-/]*", text))


def count_phrases(text: str, phrases: list[str]) -> tuple[int, list[str]]:
    count = 0
    hits: list[str] = []
    lowered = text.lower()
    for phrase in phrases:
        matches = list(
            re.finditer(r"(?<![a-z])" + re.escape(phrase) + r"(?![a-z])", lowered)
        )
        count += len(matches)
        hits.extend(phrase for _ in matches)
    return count, hits


def lint(text: str) -> dict[str, object]:
    raw = text
    text = strip_code(text)
    parsed_sentences = sentences(text)
    words = sum(word_count(sentence) for sentence in parsed_sentences) or 1
    long_sentences = [
        (word_count(sentence), sentence)
        for sentence in parsed_sentences
        if word_count(sentence) > 20
    ]
    violations: dict[str, int] = {
        "long_sentence(>20w)": len(long_sentences),
        "semicolon": text.count(";"),
        "contraction": len(
            re.findall(r"\b\w+['’](?:t|re|ve|ll|d|s|m)\b", text)
        ),
        "passive_voice": len(
            re.findall(
                rf"\b{BE}\s+(?:\w+ed|{IRREGULAR_PARTICIPLE})\b", text, re.I
            )
        ),
        "ing_main_verb": len(re.findall(rf"\b{BE}\s+\w+ing\b", text, re.I)),
        "nominalization": len(
            re.findall(
                r"\b(?:perform(?:s|ed)?|conduct(?:s|ed)?|provide(?:s|d)?|"
                r"carry out|carries out|make use of|makes use of)\b",
                text,
                re.I,
            )
        )
        + len(re.findall(r"\b\w{4,}(?:tion|ment|ance|ence)\s+of\b", text, re.I)),
    }
    violations["phrasal_verb"], _ = count_phrases(text, PHRASAL)
    violations["banned_word"], banned_hits = count_phrases(text, BANNED)
    violations["marketing_adjective"], marketing_hits = count_phrases(text, MARKETING)
    violations["modal_hedge"], _ = count_phrases(text, MODAL_HEDGE)
    paragraphs = [p for p in re.split(r"\n\s*\n", raw) if p.strip()]
    violations["long_paragraph(>6s)"] = sum(
        1 for paragraph in paragraphs if len(sentences(strip_code(paragraph))) > 6
    )
    total = sum(violations.values())
    longest_sentence = max(
        (word_count(sentence) for sentence in parsed_sentences), default=0
    )
    return {
        "words": words,
        "sentences": len(parsed_sentences),
        "violations": violations,
        "total": total,
        "total_per100w": round(total * 100.0 / words, 2),
        "em_dash(slop-marker)": raw.count("—") + raw.count("–"),
        "longest_sentence_words": longest_sentence,
        "sample_marketing": list(dict.fromkeys(marketing_hits))[:6],
        "sample_banned": list(dict.fromkeys(banned_hits))[:6],
    }


def main(arguments: list[str]) -> int:
    if not arguments:
        print(json.dumps(lint(sys.stdin.read()), indent=2))
        return 0

    paths: list[str] = []
    for argument in arguments:
        if any(character in argument for character in "*?["):
            paths.extend(sorted(glob.glob(argument)))
        else:
            paths.append(argument)

    for path in paths:
        with open(path, encoding="utf-8") as handle:
            result = lint(handle.read())
        print(
            f"{os.path.basename(path):32} "
            f"words={result['words']:4d} "
            f"total={result['total']:3d} "
            f"per100w={result['total_per100w']:6.2f} "
            f"em_dash={result['em_dash(slop-marker)']:2d}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
