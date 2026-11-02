/**
 * The principle slot (`docs/specs/2026-10-27-brain-principles-playbooks-design.md`).
 *
 * A principle is a memory file under `principles/`. The assistant's memory
 * snapshot carries a Principles section: the base principle in full, then
 * one index line per principle file the scope can read. Bodies stay out of
 * the prompt; the model reads one with `mem_read` when it applies.
 */
import { BUILTIN_PRINCIPLES, builtinPrinciplePath } from "@valet/shared";
import { PRINCIPLES_DIR, SYNCED_PRINCIPLES_DIR, type MemoryFileSummary } from "../services/memory.js";

/** Index caps. The section is never dropped for the snapshot budget, so it
 * must stay bounded. The index stops at whichever cap it reaches first. */
export const PRINCIPLE_INDEX_MAX_ENTRIES = 40;
export const PRINCIPLE_INDEX_MAX_CHARS = 4000;

/** The base principle's name. A turn cites it by this name. */
export const BASE_PRINCIPLE_NAME = "learn-from-the-org";

/**
 * The base principle. Valet ships it, so every brain starts with it. It is
 * the base case and the inductive case: a principle that makes principles.
 */
export const BASE_PRINCIPLE = `### ${BASE_PRINCIPLE_NAME} (built in)

Applies when a person tells you how they want the work done.

- If a person corrects you or states a rule for your work, write a personal principle in your own memory.
- Save a principle with save_principle. Give the rule in a few words, when it applies in one line, and the details: the rule, the reason, and one example.
- Before you write, search \`principles/\` with mem_search. If a principle covers the same rule, update it. Do not make a duplicate.
- Principles change as you learn. If a principle you followed was wrong or incomplete, or a person corrects how you applied it, update it: call save_principle with the same name, or patch it with mem_patch. A built-in principle has no file until you change it. Your change replaces the built-in for this scope.
- A principle under \`lib/principles/\` comes from a synced repository and is read-only. To change one, tell the person to change it in that repository, or save a personal principle that refines it.
- Write a team principle only when a person in this conversation asks you to add the rule to a team. Then pass that team's \`teamId\`. Only a team admin or an organization admin can write a team principle. If the write is refused, tell the person and offer to save the rule as a personal principle.
- Before you make a choice in open-ended work, check the index below. Read a principle with mem_read before you follow it. Say which principle you followed.
- Do not write secrets, credentials, or one-time facts as principles.`;

/** The base principle for a session that cannot write memory: a child
 * session or a workflow step. It reads and follows principles, and hands a
 * stated rule back instead of saving it. */
export const READ_ONLY_BASE_PRINCIPLE = `### ${BASE_PRINCIPLE_NAME} (built in)

Applies when a person tells you how they want the work done.

- Before you make a choice in open-ended work, check the index below. Read a principle with mem_read before you follow it. Say which principle you followed.
- You cannot write memory in this session. If a person corrects you or states a rule for your work, put the rule in your result, so an assistant can save it as a principle.`;

/** True for a principle file, in the own scope or under a team's `team:{id}/` prefix.
 * A principle synced from a repository's `.valet/memory/principles/` mounts at
 * `lib/principles/`, so that directory holds principles too. */
export function isPrincipleFile(path: string): boolean {
  const own = path.replace(/^team:[^/]+\//, "");
  return [PRINCIPLES_DIR, SYNCED_PRINCIPLES_DIR].some((dir) => own.startsWith(dir) && own.length > dir.length);
}

/** Index lines for the built-in principles that no own file replaces. */
function builtinIndexLines(files: PrincipleIndexEntry[]): string[] {
  const own = new Set(files.map((file) => file.path));
  return BUILTIN_PRINCIPLES.filter((principle) => !own.has(builtinPrinciplePath(principle)))
    .map((principle) => `- ${builtinPrinciplePath(principle)} — ${principle.rule} (built in): ${principle.when}`);
}

/** What an index line shows. The snapshot passes full summaries, so the
 * selection below hands back each one's owner key with it. */
export type PrincipleIndexEntry = Pick<MemoryFileSummary, "path" | "title" | "description">;

function indexLine(file: PrincipleIndexEntry): string {
  const title = file.title ? ` — ${file.title}` : "";
  const when = file.description ? `: ${file.description}` : "";
  return `- ${file.path}${title}${when}`;
}

/** Own principles first, then team principles. Each group is in path
 * order, so team entries group by team id. */
function comparePrinciples(a: PrincipleIndexEntry, b: PrincipleIndexEntry): number {
  const aTeam = a.path.startsWith("team:") ? 1 : 0;
  const bTeam = b.path.startsWith("team:") ? 1 : 0;
  return aTeam - bTeam || a.path.localeCompare(b.path);
}

/** The principle files the index lists, in index order, within the caps.
 * The snapshot records an injection for each one. */
export function selectIndexedPrinciples<T extends PrincipleIndexEntry>(files: T[]): T[] {
  const principles = files.filter((file) => isPrincipleFile(file.path)).sort(comparePrinciples);
  const listed: T[] = [];
  let chars = 0;
  for (const file of principles) {
    const line = indexLine(file);
    if (listed.length >= PRINCIPLE_INDEX_MAX_ENTRIES || chars + line.length + 1 > PRINCIPLE_INDEX_MAX_CHARS) break;
    listed.push(file);
    chars += line.length + 1;
  }
  return listed;
}

/** The Principles section of the memory snapshot. It always renders, so the
 * slot exists before the first principle does. */
export function renderPrinciplesSection(files: PrincipleIndexEntry[], opts: { readOnly?: boolean } = {}): string {
  const principles = files.filter((file) => isPrincipleFile(file.path));
  const listed = selectIndexedPrinciples(principles).map(indexLine);
  const hidden = principles.length - listed.length;
  const index = [...listed, ...builtinIndexLines(principles)];
  if (hidden > 0) {
    index.push(
      `(${hidden} more principles are not listed. To see all of them, read the directory with mem_read \`principles/\`, \`lib/principles/\`, or \`team:<id>/principles/\`.)`,
    );
  }
  return [
    "## Principles",
    "",
    "Principles guide open-ended work. Read one with mem_read before you follow it.",
    "",
    opts.readOnly ? READ_ONLY_BASE_PRINCIPLE : BASE_PRINCIPLE,
    "",
    "### Index",
    "",
    ...index,
  ].join("\n");
}
