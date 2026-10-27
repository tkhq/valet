/**
 * The principle slot (`docs/specs/2026-10-27-brain-principles-playbooks-design.md`).
 *
 * A principle is a memory file under `principles/`. The assistant's memory
 * snapshot carries a Principles section: the base principle in full, then
 * one index line per principle file the scope can read. Bodies stay out of
 * the prompt; the model reads one with `mem_read` when it applies.
 */
import type { MemoryFileSummary } from "../services/memory.js";

export const PRINCIPLES_DIR = "principles/";

/**
 * The base principle. Valet ships it, so every brain starts with it. It is
 * the base case and the inductive case: a principle that makes principles.
 */
export const BASE_PRINCIPLE = `### learn-from-the-org (built in)

Applies when the organization shows you how it works.

- If a person corrects you, states a rule, or you see the organization make the same choice two or more times, write a principle.
- Write a principle with mem_write at \`principles/<name>.md\`. Set the title to the rule in a few words. Set the description to when the rule applies, in one line. In the body, write the rule, the reason, and one example.
- Before you write, search \`principles/\` with mem_search. If a principle covers the same rule, update it. Do not make a duplicate.
- If the rule belongs to a team, write it to that team's memory with \`teamId\`. If the rule is personal, write it to your own memory.
- Before you make a choice in open-ended work, check the index below. Read a principle with mem_read before you follow it. Say which principle you followed.
- Do not write secrets, credentials, or one-time facts as principles.`;

/** True for a principle file, in the own scope or under a team's `team:{id}/` prefix. */
export function isPrincipleFile(path: string): boolean {
  const own = path.replace(/^team:[^/]+\//, "");
  return own.startsWith(PRINCIPLES_DIR) && own.length > PRINCIPLES_DIR.length;
}

/** The Principles section of the memory snapshot. It always renders, so the
 * slot exists before the first principle does. */
export function renderPrinciplesSection(files: MemoryFileSummary[]): string {
  const principles = files.filter((file) => isPrincipleFile(file.path));
  const index = principles.length > 0
    ? principles.map((file) => {
      const title = file.title ? ` — ${file.title}` : "";
      const when = file.description ? `: ${file.description}` : "";
      return `- ${file.path}${title}${when}`;
    })
    : ["(No principles yet. The base principle tells you when to write one.)"];
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
