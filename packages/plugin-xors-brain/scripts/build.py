#!/usr/bin/env python3
"""Generate data/brain.json from the xors-brain repo.

Usage:
    python3 packages/plugin-xors-brain/scripts/build.py [--brain PATH] [--max-sensitivity internal]

Confidential entries never ship unless you pass --max-sensitivity confidential.
The bundle holds one record per entry plus its BM25 term counts, so search in
the plugin ranks exactly like `brain.py search`. It stays JSON because `tsc`
runs out of heap on a 400 KB TypeScript literal.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent
PLUGIN = HERE.parent
DEFAULT_BRAIN = PLUGIN.parents[2] / "xors-brain"

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--brain", type=Path, default=DEFAULT_BRAIN)
    ap.add_argument("--max-sensitivity", default="internal",
                    choices=["public", "internal", "confidential"])
    args = ap.parse_args()

    sys.path.insert(0, str(args.brain / "tools"))
    import brainlib as bl  # noqa: E402

    entries = bl.load_entries(args.brain / "brain")
    errors = bl.validate(entries)
    if errors:
        print("brain has schema errors, fix them first:", *errors, sep="\n  ", file=sys.stderr)
        return 1

    cap = bl.SENSITIVITY_RANK[args.max_sensitivity]
    kept = [e for e in entries if bl.SENSITIVITY_RANK.get(e.sensitivity, 1) <= cap]

    docs = []
    for e in kept:
        toks = e.searchable()
        docs.append({
            "id": e.id,
            "title": e.title,
            "section": e.section,
            "type": e.meta.get("type", ""),
            "status": e.meta.get("status", "active"),
            "sensitivity": e.sensitivity,
            "updated": str(e.meta.get("updated", "")),
            "summary": e.summary(240),
            "links": e.links,
            "tags": [str(t) for t in (e.meta.get("tags") or [])],
            "body": e.body,
            "len": len(toks),
            "tf": dict(Counter(toks)),
        })
    avg_len = sum(d["len"] for d in docs) / len(docs) if docs else 0.0
    bundle = {
        "built": date.today().isoformat(),
        "maxSensitivity": args.max_sensitivity,
        "avgLen": avg_len,
        "stopwords": sorted(bl.STOPWORDS),
        "docs": docs,
    }

    target = PLUGIN / "data" / "brain.json"
    target.parent.mkdir(exist_ok=True)
    payload = json.dumps(bundle, ensure_ascii=False, separators=(",", ":"))
    target.write_text(payload)
    skipped = len(entries) - len(kept)
    print(f"wrote {target.relative_to(PLUGIN)}: {len(docs)} entries, "
          f"{skipped} withheld above '{args.max_sensitivity}', {len(payload) // 1024} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
