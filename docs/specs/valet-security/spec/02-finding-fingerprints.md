# Part 02: Finding Fingerprints

*Depends on: Part 00. Conformance: L0.*

## Purpose

This part fixes the deterministic function every persona and every downstream tool uses to identify a finding across cells and across re-runs. Two implementations that follow this part produce byte-identical fingerprint hex for identical inputs. The function is pure (no clock, no I/O, no randomness). It ships as a reference implementation at `docs/specs/valet-security/reference/fingerprint.py`. The 13 vectors in `docs/specs/valet-security/vectors/fingerprints.json` pin the outputs.

## Fingerprint function

**Inputs:**
1. `file` (UTF-8 string). Repository-relative path where the finding sits. Forward slashes only. May be empty for a repo-wide observation.
2. `line` (integer or null). 1-indexed line number, or null when the finding is file-scoped.
3. `title` (UTF-8 string). One-line summary. Personas MUST truncate a title longer than 200 codepoints before calling this function.
4. `body` (UTF-8 string). Full evidence and reasoning. Unbounded.

**Output:**
A 20-byte Blake2b digest, encoded as 40 lowercase hex characters.

**Normative algorithm:**
```
function fingerprint(file, line, title, body) -> bytes[20]:
  canonical_file = normalize_path(file)
  body_prefix = take_codepoints(body, 200)
  line_str = str(line) if line is not None else ""
  payload = canonical_file + "|" + line_str + "|" + title + "|" + body_prefix
  return blake2b(payload.encode("utf-8"),
                 digest_size=20,
                 salt=b"", key=b"", person=b"")
```

## Canonicalization rules

**`normalize_path(file)`** MUST:

1. Strip a single leading `/` if present. The path MUST be repo-relative.
2. Convert every backslash to a forward slash (Windows to Unix).
3. Split on `/`, drop `` (empty) and `.` segments in order.
4. For each `..` segment, pop the previous segment. If the pop would empty the accumulator (the `..` escapes the repo root), REJECT the input. Raise `PathTraversalError`.
5. Rejoin the accumulated segments with `/`.
6. Lowercase the entire path.

**Rejection semantics.** A path that resolves outside the repo root is not canonicalizable. `fingerprint()` MUST propagate the rejection. A caller that catches the exception MAY log the offending input; it MUST NOT record a finding. This is stricter than a "resolve and clip" semantics, on the security-conservative side: a persona that emits a finding whose path traverses out of the tree is either lying, buggy, or under injection. In every case, refusing is safer than accepting.

**Why lowercase?** Git is case-preserving but case-insensitive on macOS and Windows. A finding on `API/Routes.py` and `api/routes.py` is the same finding. Lowercasing produces byte-identical hex across platforms.

**`take_codepoints(body, 200)`** MUST:

1. Treat `body` as a sequence of Unicode codepoints. Codepoints are NOT bytes. `"Hello 世界"` is 8 codepoints, 12 UTF-8 bytes.
2. Return the first 200 codepoints. If `body` has fewer than 200, return all of them.
3. Encode the result as UTF-8 for the payload string concatenation.

**Why 200 codepoints?** This captures the first sentences of the evidence while keeping the payload bounded. Findings with the same `file`, `line`, `title`, and first-200 body-prefix are treated as the same finding across implementations, even if later paragraphs diverge (one persona appended a PoC; another appended a mitigation note). The fingerprint identifies findings; it is not a text-diff detector.

## Blake2b parameters

Normative:
- **Digest size:** 20 bytes (160 bits).
- **Salt:** empty bytes.
- **Key:** empty bytes.
- **Personalization:** empty bytes.

Implementations MUST use Blake2b (64-bit variant). NOT Blake2s.

## Collision resistance

**Birthday bound.** 20-byte hashes produce collisions after 2^80 findings. A large engagement runs 10,000 findings (10^4). One million engagements at 10,000 each is 10^10. 2^80 is 1.2 * 10^24. The margin is 14 orders of magnitude.

**Practical bound.** Implementations MAY assume fingerprints are unique within an engagement. If two findings have the same fingerprint, they are the same finding (deduplicate before recording).

## Edge cases

**Empty file.** `normalize_path("")` returns `""`. A finding with `file=""` is a repo-wide observation.

**Null line.** `line=None` makes `line_str=""`. Payload becomes `<file>||<title>|<body prefix>`. This is intentional: file-scoped findings have no line.

**Empty title.** Allowed. The payload has `title=""`. Personas SHOULD provide a title.

**Empty body.** `take_codepoints("", 200)` returns `""`. Allowed but discouraged.

**Non-UTF-8 input.** The function MUST reject non-UTF-8 in `file`, `title`, or `body`. Personas reviewing binary content MUST transcode or sanitize before emitting.

## Test vectors

Appendix D §D.1 pins 13 vectors. Each carries `file`, `line`, `title`, `body`, and `expected.fingerprint`. An L0 implementation MUST produce byte-identical fingerprint hex for every vector.

## Reference implementation

```python
import hashlib


class PathTraversalError(ValueError):
    """The path escapes the repo root; MUST NOT be recorded."""


def normalize_path(file: str) -> str:
    if file.startswith("/"):
        file = file[1:]
    file = file.replace("\\", "/")
    segments: list[str] = []
    for part in file.split("/"):
        if part in ("", "."):
            continue
        if part == "..":
            if not segments:
                raise PathTraversalError(f"path escapes root: {file!r}")
            segments.pop()
            continue
        segments.append(part)
    return "/".join(segments).lower()


def take_codepoints(body: str, n: int) -> str:
    if len(body) <= n:
        return body
    return body[:n]


def fingerprint(file: str, line: int | None, title: str, body: str) -> bytes:
    canonical_file = normalize_path(file)
    body_prefix = take_codepoints(body, 200)
    line_str = str(line) if line is not None else ""
    payload = f"{canonical_file}|{line_str}|{title}|{body_prefix}"
    h = hashlib.blake2b(
        payload.encode("utf-8"),
        digest_size=20,
        salt=b"",
        key=b"",
        person=b"",
    )
    return h.digest()
```

## Migration from v0 `security_findings.fingerprint`

The base design (2026-08-27, §Tools, `sec_finding_report`) documents the v0 fingerprint as `sha256(file, line / 10, normalized title) first 16 hex`. v1 changes:
- Algorithm: Blake2b (was sha256).
- Input set: `(file, line, title, body prefix 200 codepoints)` (was `(file, line/10 bucket, normalized title)`).
- Output width: 40 hex characters (was 16 hex characters).
- Column width: extend `security_findings.fingerprint TEXT` to fit 40 hex characters. Postgres text is unbounded; no length change is required. Drop any client-side assertion that pins 16 hex.

Both algorithms are deterministic. Both are collision-resistant at the scale a real engagement runs. The v1 shape is a strict superset of the v0 signal (title, file, line), extended with body-prefix, so v0 duplicates remain v1 duplicates and v0 near-duplicates stay near-duplicates. Existing v0 rows do NOT migrate: the fingerprint is per-run identity, not cross-engagement identity.

An implementation running mixed data (v0 rows written before this spec landed, v1 rows written after) MUST NOT deduplicate a v1 finding against a v0 fingerprint. Store the algorithm version on the row (a `fingerprint_algorithm TEXT DEFAULT 'v0'` column) OR drop the v0 deduplication assumption entirely and rely on the (engagement_id, path, line, title) tuple within a plan.

## Conformance

**L0.** The function is a pure function. Every vector in §D.1 passes byte-identically.

**L1 and above.** Personas call the function through `sec_finding_report`. The server computes the fingerprint before insert and returns the id plus any existing rows sharing the fingerprint (advisory dedup). Callers do NOT recompute.
