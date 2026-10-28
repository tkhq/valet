/**
 * The principle slot (`docs/specs/2026-10-27-brain-principles-playbooks-design.md`).
 *
 * A principle is a memory file under `principles/`. The assistant's memory
 * snapshot carries a Principles section: the base principle in full, then
 * one index line per principle file the scope can read. Bodies stay out of
 * the prompt; the model reads one with `mem_read` when it applies.
 */
import { PRINCIPLES_DIR, type MemoryFileSummary } from "../services/memory.js";

/** Index caps. The section is never dropped for the snapshot budget, so it
 * must stay bounded. The index stops at whichever cap it reaches first. */
export const PRINCIPLE_INDEX_MAX_ENTRIES = 40;
export const PRINCIPLE_INDEX_MAX_CHARS = 4000;

/**
 * The base principle. Valet ships it, so every brain starts with it. It is
 * the base case and the inductive case: a principle that makes principles.
 */
export const BASE_PRINCIPLE = `### learn-from-the-org (built in)

Applies when a person tells you how they want the work done.

- If a person corrects you or states a rule for your work, write a personal principle in your own memory.
- Write a principle with mem_write at \`principles/<name>.md\`. Set the title to the rule in a few words. Set the description to when the rule applies, in one line. In the body, write the rule, the reason, and one example.
- Before you write, search \`principles/\` with mem_search. If a principle covers the same rule, update it. Do not make a duplicate.
- Write a team principle only when a person in this conversation asks you to add the rule to a team. Then pass that team's \`teamId\`. Only a team admin or an organization admin can write a team principle. If the write is refused, tell the person and offer to save the rule as a personal principle.
- Before you make a choice in open-ended work, check the index below. Read a principle with mem_read before you follow it. Say which principle you followed.
- Do not write secrets, credentials, or one-time facts as principles.`;

/** True for a principle file, in the own scope or under a team's `team:{id}/` prefix. */
export function isPrincipleFile(path: string): boolean {
  const own = path.replace(/^team:[^/]+\//, "");
  return own.startsWith(PRINCIPLES_DIR) && own.length > PRINCIPLES_DIR.length;
}

function indexLine(file: MemoryFileSummary): string {
  const title = file.title ? ` — ${file.title}` : "";
  const when = file.description ? `: ${file.description}` : "";
  return `- ${file.path}${title}${when}`;
}

/** Own principles first, then team principles. Each group is in path
 * order, so team entries group by team id. */
function comparePrinciples(a: MemoryFileSummary, b: MemoryFileSummary): number {
  const aTeam = a.path.startsWith("team:") ? 1 : 0;
  const bTeam = b.path.startsWith("team:") ? 1 : 0;
  return aTeam - bTeam || a.path.localeCompare(b.path);
}

/** The Principles section of the memory snapshot. It always renders, so the
 * slot exists before the first principle does. */
export function renderPrinciplesSection(files: MemoryFileSummary[]): string {
  const principles = files.filter((file) => isPrincipleFile(file.path)).sort(comparePrinciples);
  const index: string[] = [];
  let chars = 0;
  for (const file of principles) {
    const line = indexLine(file);
    if (index.length >= PRINCIPLE_INDEX_MAX_ENTRIES || chars + line.length + 1 > PRINCIPLE_INDEX_MAX_CHARS) break;
    index.push(line);
    chars += line.length + 1;
  }
  const hidden = principles.length - index.length;
  if (principles.length === 0) {
    index.push("(No principles yet. The base principle tells you when to write one.)");
  } else if (hidden > 0) {
    index.push(
      `(${hidden} more principles are not listed. To see all of them, read the directory with mem_read \`principles/\` or \`team:<id>/principles/\`.)`,
    );
  }
  return [
    "## Principles",
    "",
    "Principles guide open-ended work. Read one with mem_read before you follow it.",
    "",
    BASE_PRINCIPLE,
    "",
    "### Index",
    "",
    ...index,
  ].join("\n");
}
