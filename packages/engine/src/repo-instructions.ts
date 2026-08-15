/**
 * System-prompt fragment for repository AGENTS.md instructions
 * (docs/specs/2026-08-15-agents-md-instructions-design.md, decision 3).
 *
 * The engine owns the framing; the host owns discovery and reading (it
 * supplies a size-capped `RepoInstructions` via
 * `CreateSessionOptions.repoInstructionsProvider`). The preamble's
 * user-precedence sentence is what upholds the AGENTS.md format's rule that
 * "explicit user chat prompts override everything" — do not drop it.
 */
import type { RepoInstructions } from "./types.js";

const PREAMBLE =
  "The repository provides AGENTS.md instructions for coding agents. " +
  "Follow them. Explicit user instructions in the conversation override them.";

const NESTED_HEADER = "Other AGENTS.md files exist in this workspace:";

const NESTED_RULE =
  "Before you edit files under these directories, read the nearest AGENTS.md; " +
  "the closest one to the edited file wins.";

/**
 * Renders the per-turn overlay fragment: preamble, then the root file
 * content verbatim, then the nested-path list with the format's
 * closest-file-wins rule. An empty `content` (monorepo with only nested
 * files) skips the content block; empty `nestedPaths` skips the list.
 * Returns "" when there is nothing to say — callers skip the overlay then.
 */
export function buildRepoInstructionsFragment(instructions: RepoInstructions): string {
  const content = instructions.content.trim();
  const nested = instructions.nestedPaths.filter((p) => p.trim() !== "");
  if (!content && nested.length === 0) return "";
  const parts: string[] = [PREAMBLE];
  if (content) parts.push(content);
  if (nested.length > 0) {
    const list = nested.map((p) => `- ${p}`).join("\n");
    parts.push(`${NESTED_HEADER}\n${list}\n${NESTED_RULE}`);
  }
  return parts.join("\n\n");
}
