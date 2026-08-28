import { parse } from "yaml";
import { KNOWN_PLAYBOOKS, isKnownPlaybook } from "./playbooks.js";

/** One unit of dispatch: a persona, a mode, a goal. See the design spec
 * (docs/specs/2026-08-27-valet-security-design.md §Vocabulary). */
export interface PlanCell {
  ordinal: number;
  persona: string;
  mode: "fresh" | "resume";
  goal: string;
  /** Optional short label for the cell's state-doc directory. Slugified;
   * falls back to the goal when absent. See `cellDir`. */
  name?: string;
  /** Earlier ordinals whose state docs this cell's dispatch prompt names. */
  reads: number[];
  /** Optional include globs that scope the cell to part of the repo. */
  paths?: string[];
  /** Grants `sec_finding_review` to the cell's child session. */
  review?: boolean;
  /** Optional methodology playbook (a KNOWN_PLAYBOOKS name). Its markdown is
   * served at /playbooks/<name>.md and named in the dispatch prompt. */
  playbook?: string;
  /** When true, this phase runs as an architect → worker → verifier triad
   * (M-P2b). `expandTriads` replaces the cell with three ordered cells at
   * `startEngagement` materialization: `<name>-plan` (architect), `<name>`
   * (this persona, the worker), `<name>-verify` (verifier, review). A plan
   * carries `triad: true` on the phase cell; the materialized cells never do
   * (they are already expanded). */
  triad?: boolean;
}

export interface EngagementPlan {
  cells: PlanCell[];
}

/** Serial v1 keeps plans small; a bigger plan is a scoping problem. */
export const MAX_PLAN_CELLS = 32;

const CORRECTIVE = "Fix the plan and call sec_plan_set again.";

/**
 * Parse and validate an engagement plan. Throws an Error with a corrective
 * message on the first violation. Validation rules come from the spec's
 * `sec_plan_set` contract: known personas, dense ordinals 1..N, `reads`
 * reference earlier ordinals only, at most MAX_PLAN_CELLS cells.
 */
export function parsePlan(yaml: string, knownPersonas: readonly string[]): EngagementPlan {
  let raw: unknown;
  try {
    raw = parse(yaml);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`The plan is not valid YAML (${detail}). ${CORRECTIVE}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`The plan must be a YAML map with a "cells" list. ${CORRECTIVE}`);
  }
  const cellsRaw = (raw as Record<string, unknown>).cells;
  if (!Array.isArray(cellsRaw) || cellsRaw.length === 0) {
    throw new Error(`The plan must have a non-empty "cells" list. ${CORRECTIVE}`);
  }
  if (cellsRaw.length > MAX_PLAN_CELLS) {
    throw new Error(
      `The plan has ${cellsRaw.length} cells; the maximum is ${MAX_PLAN_CELLS}. Merge related goals into fewer cells. ${CORRECTIVE}`,
    );
  }

  const cells = cellsRaw.map((entry, index) => parseCell(entry, index, knownPersonas));

  cells.sort((a, b) => a.ordinal - b.ordinal);
  for (let i = 0; i < cells.length; i++) {
    const expected = i + 1;
    if (cells[i].ordinal !== expected) {
      throw new Error(
        `Cell ordinals must be dense 1..${cells.length}; expected ordinal ${expected} but found ${cells[i].ordinal}. Renumber the cells. ${CORRECTIVE}`,
      );
    }
  }

  for (const cell of cells) {
    for (const read of cell.reads) {
      if (!Number.isInteger(read) || read < 1 || read > cells.length) {
        throw new Error(
          `Cell ${cell.ordinal} reads ordinal ${read}, which is not in the plan. List only existing ordinals. ${CORRECTIVE}`,
        );
      }
      if (read >= cell.ordinal) {
        throw new Error(
          `Cell ${cell.ordinal} reads ordinal ${read}; reads must name earlier ordinals only. List ordinals below ${cell.ordinal}. ${CORRECTIVE}`,
        );
      }
    }
  }

  return { cells };
}

function parseCell(entry: unknown, index: number, knownPersonas: readonly string[]): PlanCell {
  const label = `cells[${index}]`;
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new Error(`${label} must be a map with ordinal, persona, and goal. ${CORRECTIVE}`);
  }
  const cell = entry as Record<string, unknown>;

  const ordinal = cell.ordinal;
  if (typeof ordinal !== "number" || !Number.isInteger(ordinal)) {
    throw new Error(`${label} needs an integer "ordinal". ${CORRECTIVE}`);
  }

  const persona = cell.persona;
  if (typeof persona !== "string" || !knownPersonas.includes(persona)) {
    throw new Error(
      `${label} names unknown persona "${String(persona)}". Known personas: ${knownPersonas.join(", ")}. ${CORRECTIVE}`,
    );
  }

  const mode = cell.mode ?? "fresh";
  if (mode !== "fresh" && mode !== "resume") {
    throw new Error(`${label} has mode "${String(mode)}"; use "fresh" or "resume". ${CORRECTIVE}`);
  }

  const goal = cell.goal;
  if (typeof goal !== "string" || goal.trim() === "") {
    throw new Error(`${label} needs a non-empty "goal". Write what the cell must accomplish. ${CORRECTIVE}`);
  }

  let name: string | undefined;
  if (cell.name !== undefined) {
    if (typeof cell.name !== "string" || cell.name.trim() === "") {
      throw new Error(`${label} has a non-text "name". Write a short directory label, or omit it. ${CORRECTIVE}`);
    }
    if (cell.name.length > NAME_MAX) {
      throw new Error(
        `${label} has a "name" longer than ${NAME_MAX} characters. Shorten the directory label. ${CORRECTIVE}`,
      );
    }
    name = slugify(cell.name);
    if (name === "") {
      throw new Error(
        `${label} has a "name" with no slug characters. Use letters or digits in the label. ${CORRECTIVE}`,
      );
    }
  }

  const readsRaw = cell.reads ?? [];
  if (!Array.isArray(readsRaw) || readsRaw.some((r) => typeof r !== "number")) {
    throw new Error(`${label} has a non-numeric "reads" list. List earlier ordinals as numbers. ${CORRECTIVE}`);
  }
  const reads = readsRaw.filter((r): r is number => typeof r === "number");

  let paths: string[] | undefined;
  if (cell.paths !== undefined) {
    if (!Array.isArray(cell.paths) || cell.paths.some((p) => typeof p !== "string")) {
      throw new Error(`${label} has a non-text "paths" list. List include globs as text. ${CORRECTIVE}`);
    }
    paths = cell.paths.filter((p): p is string => typeof p === "string");
  }

  let review: boolean | undefined;
  if (cell.review !== undefined) {
    if (typeof cell.review !== "boolean") {
      throw new Error(`${label} has a non-boolean "review". Use true or false. ${CORRECTIVE}`);
    }
    review = cell.review;
  }

  let playbook: string | undefined;
  if (cell.playbook !== undefined) {
    if (typeof cell.playbook !== "string" || !isKnownPlaybook(cell.playbook)) {
      throw new Error(
        `${label} names unknown playbook "${String(cell.playbook)}". Known playbooks: ${KNOWN_PLAYBOOKS.join(", ")}. ${CORRECTIVE}`,
      );
    }
    playbook = cell.playbook;
  }

  let triad: boolean | undefined;
  if (cell.triad !== undefined) {
    if (typeof cell.triad !== "boolean") {
      throw new Error(`${label} has a non-boolean "triad". Use true or false. ${CORRECTIVE}`);
    }
    triad = cell.triad;
  }

  return { ordinal, persona, mode, goal, name, reads, paths, review, playbook, triad };
}

const SLUG_MAX = 40;

/** Longest raw `name` a cell may carry. Slugified names stay filesystem-safe. */
const NAME_MAX = 24;

/** Lower-case, hyphenate, trim, and cap a label to SLUG_MAX slug characters. */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, "");
}

/**
 * Stable cell directory name: 2-digit ordinal, hyphen, slugified goal.
 * Example: cellDirSlug(1, "Map the codebase & seed checklist") ===
 * "01-map-the-codebase-seed-checklist". Stamped on the cell row at
 * sec_start so dispatch prompts can name paths literally.
 */
export function cellDirSlug(ordinal: number, goal: string): string {
  return `${String(ordinal).padStart(2, "0")}-${slugify(goal)}`;
}

/**
 * Cell directory name from a cell's optional short `name`, falling back to
 * the goal. Prefer this over cellDirSlug: a name gives a short stable dir
 * (`02-authz-sweep`) instead of a 40-char goal slug.
 */
export function cellDir(cell: { ordinal: number; name?: string; goal: string }): string {
  return `${String(cell.ordinal).padStart(2, "0")}-${slugify(cell.name ?? cell.goal)}`;
}
