/**
 * Which repository paths content sync mirrors into memory, and where each
 * one mounts. Pure, so `valet validate` applies the rule `memory-collector.ts`
 * applies. Read that file for why mirrored memory lands under `lib/`.
 */
import { assertWritablePath, normalizePath } from "../../lib/okf.js";

export const MEMORY_ROOT = ".valet/memory";

/** Where a mirrored file lands. `lib/` is reserved for mounted libraries, so
 * putting mirrored content there is what makes it read-only. */
export const MOUNT_PREFIX = "lib/";

/** True for a Markdown file under `.valet/memory/`, the one root sync reads. */
export function isMemoryFilePath(path: string): boolean {
  return path.startsWith(`${MEMORY_ROOT}/`) && path.endsWith(".md") && path.length > MEMORY_ROOT.length + 1;
}

/**
 * The memory path one repository path mounts at, or the reason it has none.
 *
 * `normalizePath` and `assertWritablePath` both THROW, and a repository path
 * is not ours to choose: a colon is legal in a git tree and ordinary in a
 * filename ("2026-08-24: retro.md"), and so is a basename the store reserves.
 * Throwing out of the reconcile loop would abort the pass and take every
 * OTHER memory file in the repository with it, on every poll, forever. One
 * file's name costs that file only.
 *
 * `assertWritablePath` is applied deliberately, with `lib/` allowed: it is
 * the rule a WRITTEN path obeys, and mirroring a path the product could never
 * hold would create a row no other code can address.
 */
export function mountPath(repoPath: string): { ok: true; path: string } | { ok: false; reason: string } {
  const path = `${MOUNT_PREFIX}${repoPath.slice(MEMORY_ROOT.length + 1)}`;
  try {
    const normalized = normalizePath(path);
    // Strip the mount prefix for the reserved-name check, then put it back:
    // `lib/` is exactly what this collector is allowed to write and
    // `assertWritablePath` exists to refuse.
    assertWritablePath(normalized.slice(MOUNT_PREFIX.length));
    return { ok: true, path: normalized };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
