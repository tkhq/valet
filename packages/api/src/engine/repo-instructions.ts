/**
 * Host-side reader for repo AGENTS.md instructions
 * (docs/specs/2026-08-15-agents-md-instructions-design.md, decisions 2, 6, 7).
 *
 * One exec per refresh, same one-round-trip pattern as the workspace-skills
 * scan in command-providers.ts:
 *  1. `find` every AGENTS.md under `/workspace` (excluding `.git` and
 *     `node_modules`), sorted, capped at {@link MAX_NESTED_PATHS}.
 *  2. A `===VALET-AGENTS <path|none>` marker line.
 *  3. The primary binding's root AGENTS.md content — or CLAUDE.md when the
 *     binding root has no AGENTS.md (spec decision 7's Valet extension) —
 *     dumped with `head -c` one byte past {@link MAX_INLINE_BYTES} so the
 *     parser can detect truncation.
 *
 * The engine owns the fragment framing; this module only discovers and
 * reads. `parseRepoInstructionsOutput` is exported pure for unit coverage.
 */
import type { RepoInstructions, Sandbox } from "@valet/engine";
import { shQuote } from "./workspace-prep.js";

/** Cap on inlined root content (spec decision 6): 24 KB ≈ 6k tokens. */
export const MAX_INLINE_BYTES = 24 * 1024;

/** Cap on discovered AGENTS.md paths (spec decision 2). */
export const MAX_NESTED_PATHS = 25;

/** Marker line between the found-paths list and the root file dump. */
const DELIM = "===VALET-AGENTS";

/** `find` won't descend past this; a deeper AGENTS.md is out of scope. */
const MAX_FIND_DEPTH = 8;

/**
 * Builds the scan exec for a primary binding rooted at `rootDir` (an
 * absolute in-sandbox path, no trailing slash). Exported for tests.
 */
export function buildRepoInstructionsExec(rootDir: string): string {
  const agentsFile = shQuote(`${rootDir}/AGENTS.md`);
  const claudeFile = shQuote(`${rootDir}/CLAUDE.md`);
  const dump = MAX_INLINE_BYTES + 1;
  const script = [
    `find /workspace -maxdepth ${MAX_FIND_DEPTH} \\( -name .git -o -name node_modules \\) -prune -o -type f -name AGENTS.md -print 2>/dev/null | sort | head -n ${MAX_NESTED_PATHS}`,
    `if [ -f ${agentsFile} ]; then printf '${DELIM} %s\\n' ${agentsFile}; head -c ${dump} ${agentsFile};`,
    `elif [ -f ${claudeFile} ]; then printf '${DELIM} %s\\n' ${claudeFile}; head -c ${dump} ${claudeFile};`,
    `else printf '${DELIM} none\\n'; fi`,
  ].join("\n");
  return `sh -c ${shQuote(script)}`;
}

/**
 * Parses the scan exec's stdout into `RepoInstructions`. Returns `null`
 * when the workspace carries no instructions at all (no root file and no
 * discovered paths). The root file's own path is excluded from
 * `nestedPaths`; content beyond {@link MAX_INLINE_BYTES} is cut and marked
 * with a pointer to the full file (spec decision 6).
 */
export function parseRepoInstructionsOutput(stdout: string): RepoInstructions | null {
  const markerIdx = stdout.startsWith(`${DELIM} `)
    ? 0
    : stdout.indexOf(`\n${DELIM} `) + 1;
  // indexOf miss (-1) + 1 === 0 collides with a legitimate marker at offset
  // 0, so the startsWith branch handles that case first; a remaining 0 from
  // the indexOf path means no marker anywhere — malformed output.
  if (markerIdx === 0 && !stdout.startsWith(`${DELIM} `)) {
    throw new Error(`repo-instructions: scan output carries no ${DELIM} marker`);
  }

  const pathsBlock = stdout.slice(0, Math.max(0, markerIdx - 1));
  const foundPaths = pathsBlock
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

  const markerLineEnd = stdout.indexOf("\n", markerIdx);
  const markerLine = markerLineEnd === -1 ? stdout.slice(markerIdx) : stdout.slice(markerIdx, markerLineEnd);
  const sourcePath = markerLine.slice(`${DELIM} `.length).trim();
  const raw = markerLineEnd === -1 ? "" : stdout.slice(markerLineEnd + 1);

  const hasRoot = sourcePath !== "none" && sourcePath !== "";
  const nestedPaths = foundPaths.filter((p) => !hasRoot || p !== sourcePath);
  if (!hasRoot && nestedPaths.length === 0) return null;

  let content = "";
  if (hasRoot) {
    // The dump is capped at MAX_INLINE_BYTES + 1 bytes, so a byte length
    // past the cap proves the file goes on. Character slicing under-cuts on
    // multi-byte content (chars ≤ bytes) — acceptable for a cap.
    const truncated = Buffer.byteLength(raw, "utf8") > MAX_INLINE_BYTES;
    content = truncated
      ? `${raw.slice(0, MAX_INLINE_BYTES)}\n[truncated — read ${sourcePath} for the full file]`
      : raw;
  }

  return { content, nestedPaths };
}

/**
 * Builds the `repoInstructionsProvider` for a session whose primary repo
 * binding clones into `primaryTargetDir` (workspace-relative, `"."` for the
 * legacy root layout).
 *
 * `sandbox()` resolves the session's sandbox lazily and returns `undefined`
 * until the attachment is `ready` — the provider then THROWS rather than
 * returning `null`, so a not-ready race never clears previously loaded
 * instructions (`Session.refreshRepoInstructions` keeps the old value on a
 * rejection). An exec failure throws for the same reason.
 */
export function makeRepoInstructionsProvider(
  sandbox: () => Sandbox | undefined,
  primaryTargetDir: string,
): () => Promise<RepoInstructions | null> {
  const rel = primaryTargetDir.replace(/^\.\/?/, "").replace(/\/+$/, "");
  const rootDir = rel === "" ? "/workspace" : `/workspace/${rel}`;
  const exec = buildRepoInstructionsExec(rootDir);
  return async (): Promise<RepoInstructions | null> => {
    const sb = sandbox();
    if (!sb) {
      throw new Error("repo-instructions: sandbox is not ready; retrying on the next ready transition");
    }
    const result = await sb.exec(exec);
    if (result.exitCode !== 0) {
      throw new Error(
        `repo-instructions: scan exec exited ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
    return parseRepoInstructionsOutput(result.stdout);
  };
}
