/**
 * Path resolution and validation for sandbox file uploads.
 *
 * Rules from the design spec's "Path resolution" section, applied in order:
 * 1. If dest is absent, use `/workspace/uploads/<basename(filename)>`.
 * 2. If dest ends with `/`, treat it as a directory and append basename(filename).
 * 3. Reject when any of these hold:
 *    - The normalized path contains a `..` segment.
 *    - The normalized path contains a null byte.
 *    - The normalized path is not under `/workspace/`.
 *    - The normalized path is exactly `/workspace/` (root write).
 * 4. mkdir -p the parent directory inside the sandbox before writing.
 */

import { basename, normalize } from "node:path";

export function resolveUploadDest(
  filename: string,
  dest?: string,
): { ok: true; path: string } | { ok: false; error: string; corrective: string } {
  // Step 1: If dest is absent, use default.
  let target = dest ?? `/workspace/uploads/${basename(filename)}`;

  // Step 2: If dest ends with `/`, treat as directory and append basename.
  if (target.endsWith("/")) {
    target = `${target}${basename(filename)}`;
  }

  // Step 3: Normalize and validate.
  // Check raw path SEGMENTS for ".." before normalizing, to catch explicit
  // traversals. A substring check would also reject legitimate filenames
  // that merely contain consecutive dots ("report..v2.pdf").
  if (target.split("/").some((segment) => segment === "..")) {
    return {
      ok: false,
      error: "Path contains .. traversal",
      corrective: "Choose a dest under /workspace/ without parent directory references.",
    };
  }

  // Reject null bytes
  if (target.includes("\x00")) {
    return {
      ok: false,
      error: "Path contains null bytes",
      corrective: "Choose a dest without null bytes.",
    };
  }

  // Now normalize
  const normalized = normalize(target);

  // Reject paths not under /workspace/
  if (!normalized.startsWith("/workspace/")) {
    return {
      ok: false,
      error: "Path is not under /workspace/",
      corrective: "Choose a dest under /workspace/ (e.g., /workspace/uploads/file.txt).",
    };
  }

  // Reject exactly /workspace/ (root write)
  if (normalized === "/workspace" || normalized === "/workspace/") {
    return {
      ok: false,
      error: "Cannot write to /workspace/ directly",
      corrective: "Choose a subdirectory like /workspace/uploads/",
    };
  }

  return { ok: true, path: normalized };
}
