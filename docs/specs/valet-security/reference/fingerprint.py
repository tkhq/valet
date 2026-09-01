"""L0 fingerprint function per Part 02 sec 2.2.

Blake2b, 20-byte digest, empty salt/key/personalization. Pure.
"""

from __future__ import annotations

import hashlib


class PathTraversalError(ValueError):
    """The path escapes the repo root; the caller MUST NOT record a finding.

    Raised by normalize_path when a '..' segment would pop past root.
    """


def normalize_path(file: str) -> str:
    """Canonicalize a repo-relative path per Part 02 sec 2.3.

    Rules:
      1. Strip a single leading '/' if present.
      2. Convert every backslash to a forward slash.
      3. Drop '' (empty) and '.' segments.
      4. For '..': pop the previous segment; raise PathTraversalError if
         the pop would empty the accumulator (the '..' escapes root).
      5. Rejoin and lowercase.

    Rejection is stricter than clip. A finding whose path traverses out of
    tree is either lying, buggy, or under injection; refuse in every case.
    """
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
    """Return the first n Unicode codepoints of body.

    Codepoints are NOT bytes. Python str already indexes by codepoint.
    """
    if len(body) <= n:
        return body
    return body[:n]


def fingerprint(file: str, line: int | None, title: str, body: str) -> bytes:
    """Return the 20-byte Blake2b digest per Part 02 sec 2.2.

    Args:
      file: repo-relative path (may be empty for a file-scoped finding).
      line: 1-indexed line number or None for file-scoped.
      title: one-line summary; caller MUST truncate to 200 codepoints max.
      body: full evidence; the first 200 codepoints feed the payload.
    """
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


def fingerprint_hex(file: str, line: int | None, title: str, body: str) -> str:
    """Convenience: return the fingerprint as 40 lowercase hex characters."""
    return fingerprint(file, line, title, body).hex()
