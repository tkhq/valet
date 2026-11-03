/**
 * The checks behind `valet validate`: the rules content sync applies to a
 * repository, run over a local checkout before anyone pushes it.
 *
 * Sync never fails a whole repository for one bad file. It skips the file
 * and writes a warning on the source, or it loads the file in a weaker form:
 * a playbook with 21 steps loads as a plain skill and seeds no plan. Nobody
 * reads those warnings at review time. This module reports the same
 * outcomes as errors with a file and a line, so CI can stop the merge.
 *
 * Every verdict comes from the code sync runs: `discoverFromTree` for which
 * paths are skills, `parseSkillFile` and `parsePromptFile` for frontmatter,
 * `readPlaybookSteps` for playbooks, `mountPath` and `parseConcept` for
 * memory files, `readWorkflowFile` and `nextFireAt` for workflows. This
 * module only adds the lines, and it re-reads the YAML for that alone.
 *
 * Checks that need a running instance are out of scope: a workflow's event
 * keys and filters (the plugin catalog), its models and tool services, and
 * name collisions with skills a workspace already holds.
 *
 * Pure: the caller passes the tree listing and a file reader, so tests need
 * no file system.
 */
import { isMap, isSeq, LineCounter, parseDocument, type Document, type YAMLMap } from "yaml";
import { frontmatterBlock, isPlaybook, parseMarkdownArtifact, readPlaybookSteps, scanPlaybookSteps } from "@valet/engine";
import { THREAD_PLAN_MAX_ITEMS, THREAD_PLAN_MAX_TEXT } from "@valet/shared";
import { parseConcept, splitFrontmatter } from "../lib/okf.js";
import { isMemoryFilePath, MEMORY_ROOT, mountPath } from "../services/content-sync/memory-mount.js";
import { parsePromptFile, parseSkillFile } from "../services/content-sync/skill-parse.js";
import { readWorkflowFile, workflowRootFor } from "../services/content-sync/workflow-file.js";
import { discoverFromTree, MAX_SKILL_CANDIDATES, SKILL_FILE, type SkillCandidate } from "../services/skill-discovery.js";
import type { SkillTreeEntry } from "../services/skill-repo-reader.js";
import { nextFireAt } from "../workflows/next-fire.js";

export type ValidateSeverity = "error" | "warning";

/** What a finding is about. `repository` is a finding about the whole scan. */
export type ValidateKind = "skill" | "prompt" | "playbook" | "principle" | "memory" | "workflow" | "repository";

export interface ValidateFinding {
  /** Path from the repository root. */
  path: string;
  /** 1-based line, or null when the finding is about the file as a whole. */
  line: number | null;
  severity: ValidateSeverity;
  kind: ValidateKind;
  /** States what is wrong, then what to do about it. */
  message: string;
}

export interface ValidateReport {
  /** How many files of each kind the checks read. */
  checked: {
    skills: number;
    playbooks: number;
    prompts: number;
    principles: number;
    memories: number;
    workflows: number;
  };
  /** Skills and playbooks first, then memory files, then workflows. Each
   * group is in path and line order. */
  findings: ValidateFinding[];
  errors: number;
  warnings: number;
}

/** A repository as the checks see it: a git-style tree listing and a reader
 * for the files the checks open. */
export interface ValidateTree {
  entries: SkillTreeEntry[];
  read(path: string): string;
}

export interface ValidateOptions {
  /** The source subdirectory. It narrows the skill scan only, as it does
   * for a sync. Empty means the whole repository. */
  subpath?: string;
  /** Clock for the cron check. */
  now?: number;
}

/** The memory directory that holds principles: `PRINCIPLES_DIR` of the
 * memory service, under the root sync mirrors. */
const PRINCIPLES_ROOT = `${MEMORY_ROOT}/principles/`;

/** Mirrored memory keeps the sensitivity a file declares; these are the
 * values the memory service reads. */
const SENSITIVITIES = new Set(["private", "shareable"]);

const SYMLINK_MODE = "120000";

const GROUP: Record<ValidateKind, number> = {
  repository: 0,
  skill: 0,
  prompt: 0,
  playbook: 0,
  principle: 1,
  memory: 1,
  workflow: 2,
};

type Report = (line: number | null, severity: ValidateSeverity, message: string) => void;

export function validateRepository(tree: ValidateTree, opts: ValidateOptions = {}): ValidateReport {
  const subpath = (opts.subpath ?? "").replace(/^\/+|\/+$/g, "");
  const findings: ValidateFinding[] = [];
  const checked: ValidateReport["checked"] = {
    skills: 0,
    playbooks: 0,
    prompts: 0,
    principles: 0,
    memories: 0,
    workflows: 0,
  };
  const blobs = tree.entries.filter((entry) => entry.type === "blob");

  checkSkills(blobs, tree, subpath, findings, checked);
  checkMemory(blobs, tree, findings, checked);
  checkWorkflows(blobs, tree, opts.now ?? Date.now(), findings, checked);

  findings.sort((a, b) =>
    GROUP[a.kind] - GROUP[b.kind] ||
    a.path.localeCompare(b.path) ||
    (a.line ?? 0) - (b.line ?? 0));
  const errors = findings.filter((finding) => finding.severity === "error").length;
  return { checked, findings, errors, warnings: findings.length - errors };
}

// ─── Skills, prompts, and playbooks ──────────────────────────────────────

function checkSkills(
  blobs: SkillTreeEntry[],
  tree: ValidateTree,
  subpath: string,
  findings: ValidateFinding[],
  checked: ValidateReport["checked"],
): void {
  const found = discoverFromTree(blobs, subpath);
  if (found.discovered > MAX_SKILL_CANDIDATES) {
    findings.push({
      path: subpath || ".",
      line: null,
      severity: "error",
      kind: "repository",
      message: `The scan found ${found.discovered} skills and prompts. A sync reads at most ${MAX_SKILL_CANDIDATES}, so it fails and imports none. Set a subdirectory that holds fewer, and pass it with --subpath.`,
    });
  }

  // A discovery warning names the paths it is about. The file it reports is
  // the one sync did not import.
  const accepted = new Set(found.accepted.map((candidate) => candidate.path));
  const preferred = new Set(
    found.accepted.filter((candidate) => candidate.relative.startsWith(".valet/skills/")).map((candidate) => candidate.name),
  );
  const rootSkill = subpath ? `${subpath}/${SKILL_FILE}` : SKILL_FILE;
  for (const warning of found.warnings) {
    const mentioned = blobs.map((entry) => entry.path).filter((path) => mentions(warning, path));
    const path = mentioned.find((p) => !accepted.has(p)) ?? mentioned[0] ?? rootSkill;
    const name = warning.slice(0, Math.max(0, warning.indexOf(": ")));
    findings.push({
      path,
      line: null,
      // Only the `.valet/skills` preference still imports the skill.
      severity: preferred.has(name) ? "warning" : "error",
      kind: path === SKILL_FILE || path.endsWith(`/${SKILL_FILE}`) ? "skill" : "prompt",
      message: warning,
    });
  }

  for (const candidate of found.excludedCandidates) {
    findings.push({
      path: candidate.path,
      line: null,
      severity: "warning",
      kind: candidate.kind,
      message:
        "This file sits under a directory sync does not scan (a dependency, build, test, or dot folder), so Valet does not import it. Move it out of that directory, or pass --subpath to scan inside it.",
    });
  }

  for (const candidate of found.accepted) checkSkillFile(candidate, tree.read(candidate.path), findings, checked);
}

function checkSkillFile(
  candidate: SkillCandidate,
  raw: string,
  findings: ValidateFinding[],
  checked: ValidateReport["checked"],
): void {
  if (candidate.kind === "prompt") checked.prompts += 1;
  else checked.skills += 1;

  const frontmatter = readSkillFrontmatter(raw);
  const parsed = candidate.kind === "prompt" ? parsePromptFile(raw, candidate.name) : parseSkillFile(raw, candidate.name);
  const metadata = stringMap(parsed.frontmatter.metadata);
  const playbook = isPlaybook({ metadata });
  if (playbook) checked.playbooks += 1;
  const kind: ValidateKind = playbook ? "playbook" : candidate.kind;
  const at: Report = (line, severity, message) => findings.push({ path: candidate.path, line, severity, kind, message });

  for (const problem of frontmatter.problems) at(problem.line, problem.severity, problem.message);
  // A frontmatter block the parser could not read leaves every field empty.
  // The field messages that follow from that are noise next to the cause.
  if (frontmatter.unreadable) return;

  for (const violation of parsed.violations) {
    // Sync refuses a file with an `error` and imports one with only an
    // `advisory`, so an advisory is a warning here.
    at(frontmatter.keyLine(violation.field) ?? 1, violation.severity === "error" ? "error" : "warning", violation.message);
  }

  if (playbook) {
    checkPlaybookSteps(raw, frontmatter, at);
    return;
  }
  const topKind = parsed.frontmatter.kind;
  if (typeof topKind === "string" && topKind.trim().toLowerCase() === "playbook") {
    at(frontmatter.keyLine("kind") ?? 1, "error",
      'kind: playbook is a top-level field, so Valet loads this file as a plain skill. Move it under metadata: write "metadata:", then "  kind: playbook" on the next line.');
  }
  const metadataKind = metadata?.kind;
  if (metadataKind !== undefined && metadataKind.trim().toLowerCase() === "playbook") {
    at(frontmatter.keyLine("metadata") ?? 1, "error",
      `metadata.kind is "${metadataKind}", so Valet loads this file as a plain skill. Write it as playbook, in lowercase, with no spaces.`);
  }
}

/** The steps of a playbook, judged by the rule that seeds the plan. */
function checkPlaybookSteps(raw: string, frontmatter: SkillFrontmatter, at: Report): void {
  const block = frontmatterBlock(raw);
  const body = block?.closed ? block.body : raw;
  const verdict = readPlaybookSteps(body);
  if (verdict.kind === "steps") return;

  // The verdict is the parser's. The scan only finds the line to point at.
  const offset = lineCount(raw.slice(0, raw.length - body.length));
  const scan = scanPlaybookSteps(body);
  const lead = `This playbook does not set the thread plan, so Valet loads it as a plain skill. ${verdict.reason}`;
  if (scan.steps.length === 0) {
    const line = scan.headingLine !== null ? offset + scan.headingLine : frontmatter.keyLine("metadata") ?? 1;
    at(line, "error", `${lead} Add a "## Steps" heading with a numbered list under it, or remove "kind: playbook" from metadata.`);
    return;
  }
  const extra = scan.steps[THREAD_PLAN_MAX_ITEMS];
  if (extra !== undefined) {
    at(offset + extra.line, "error", `${lead} Merge steps until ${THREAD_PLAN_MAX_ITEMS} or fewer remain, or split the playbook in two.`);
    return;
  }
  const long = scan.steps.find((step) => step.text.length > THREAD_PLAN_MAX_TEXT);
  at(offset + (long?.line ?? scan.headingLine ?? 1), "error",
    `${lead} Shorten the step to ${THREAD_PLAN_MAX_TEXT} characters or fewer, and move the detail into the body.`);
}

interface FrontmatterProblem {
  line: number;
  severity: ValidateSeverity;
  message: string;
}

interface SkillFrontmatter {
  /** True when the parser dropped the whole block. */
  unreadable: boolean;
  problems: FrontmatterProblem[];
  /** The file line of a top-level field, or null when the field is absent. */
  keyLine(key: string): number | null;
}

/**
 * What the skill parser does with a file's frontmatter that it does not
 * say: a block that never closes or is not valid YAML reads as no fields at
 * all, and a list or nested map is dropped. Each case is compared against
 * the parser's own output, so the rule stays in `parseMarkdownArtifact`.
 */
function readSkillFrontmatter(raw: string): SkillFrontmatter {
  const block = frontmatterBlock(raw);
  const none = () => null;
  if (block === null) return { unreadable: false, problems: [], keyLine: none };
  if (!block.closed) {
    return {
      unreadable: true,
      keyLine: none,
      problems: [{
        line: 1,
        severity: "error",
        message: 'The frontmatter opens with "---" and never closes, so Valet reads none of its fields. Add a line with only "---" after the last field.',
      }],
    };
  }

  // The parser normalizes line breaks before it parses, so this does too.
  const lineCounter = new LineCounter();
  const doc = parseDocument(block.text.replace(/\r\n?/g, "\n"), { lineCounter });
  const fileLine = (offset: number) => block.startLine - 1 + lineCounter.linePos(offset).line;
  const yamlError = doc.errors[0];
  if (yamlError !== undefined) {
    return {
      unreadable: true,
      keyLine: none,
      problems: [{
        line: fileLine(yamlError.pos[0]),
        severity: "error",
        message: `The frontmatter is not valid YAML, so Valet reads none of its fields: ${firstLine(yamlError.message)}. Fix the YAML.`,
      }],
    };
  }
  if (doc.contents === null) return { unreadable: false, problems: [], keyLine: none };
  if (!isMap(doc.contents)) {
    return {
      unreadable: true,
      keyLine: none,
      problems: [{
        line: block.startLine,
        severity: "error",
        message: "The frontmatter is not a set of key: value fields, so Valet reads none of them. Write each field on its own line as key: value.",
      }],
    };
  }

  const lines = keyLines(doc, fileLine);
  const parsed = parseMarkdownArtifact(raw).frontmatter;
  const problems: FrontmatterProblem[] = [];
  const keyLine = (key: string) => lines.get(key) ?? null;
  let values: unknown;
  try {
    values = doc.toJS();
  } catch {
    // An alias bomb fails here and in the parser alike; the field checks
    // already report what the parser kept.
    return { unreadable: false, problems, keyLine };
  }
  if (!isPlainRecord(values)) return { unreadable: false, problems, keyLine };
  for (const [key, value] of Object.entries(values)) {
    if (value === null || value === undefined) continue;
    const line = lines.get(key) ?? block.startLine;
    const kept = parsed[key];
    if (kept === undefined) {
      problems.push({
        line,
        severity: "warning",
        message: `${key} is a list or a nested map, so Valet drops it. Write it as text, or as a map of text values.`,
      });
      continue;
    }
    if (!isPlainRecord(value) || typeof kept !== "object") continue;
    const nested = doc.contents.get(key, true);
    const innerLines = isMap(nested) ? keyLinesOf(nested, fileLine) : new Map<string, number>();
    for (const [inner, innerValue] of Object.entries(value)) {
      if (innerValue === null || innerValue === undefined || inner in kept) continue;
      problems.push({
        line: innerLines.get(inner) ?? line,
        severity: "warning",
        message: `${key}.${inner} is a list or a nested map, so Valet drops it. Write it as text.`,
      });
    }
  }
  return { unreadable: false, problems, keyLine };
}

// ─── Memory files and principles ─────────────────────────────────────────

function checkMemory(
  blobs: SkillTreeEntry[],
  tree: ValidateTree,
  findings: ValidateFinding[],
  checked: ValidateReport["checked"],
): void {
  for (const entry of blobs) {
    if (entry.mode === SYMLINK_MODE || !entry.path.startsWith(`${MEMORY_ROOT}/`)) continue;
    const principle = entry.path.startsWith(PRINCIPLES_ROOT);
    const kind: ValidateKind = principle ? "principle" : "memory";
    const at: Report = (line, severity, message) => findings.push({ path: entry.path, line, severity, kind, message });

    if (!isMemoryFilePath(entry.path)) {
      at(null, "warning", `Sync mirrors only Markdown files from ${MEMORY_ROOT}/, so it skips this file. Rename it to end in .md, or move it out of ${MEMORY_ROOT}/.`);
      continue;
    }
    if (principle) checked.principles += 1;
    else checked.memories += 1;

    const mount = mountPath(entry.path);
    if (!mount.ok) {
      at(null, "error", `Valet cannot mount this file in memory: ${mount.reason}. Rename the file.`);
      continue;
    }

    const raw = tree.read(entry.path);
    const fields = readConceptFields(raw);
    if (fields.problem !== null) {
      at(fields.problem.line, "error", fields.problem.message);
      continue;
    }
    const concept = parseConcept(raw);
    if (concept.hasFrontmatter) {
      for (const key of concept.droppedValetKeys) {
        at(fields.keyLine("valet"), "warning", `${key} is not a field Valet reads, so it is dropped. Use valet.sensitivity, valet.origin, or valet.expires.`);
      }
      const sensitivity = concept.valet.sensitivity;
      if (sensitivity !== undefined && !SENSITIVITIES.has(sensitivity)) {
        at(fields.keyLine("valet"), "warning", `valet.sensitivity is "${sensitivity}". Use private or shareable.`);
      }
      if (fields.tagsNotList) {
        at(fields.keyLine("tags"), "warning", "tags is not a list, so Valet drops it. Write tags as a YAML list, such as [deploys, ci].");
      }
    }
    if (principle) checkPrinciple(concept, fields, at);
  }
}

/**
 * A principle reaches the assistant as one index line: its path, title, and
 * description (`renderPrinciplesSection`). Without the two fields the line
 * is a bare path, and the model cannot tell when the rule applies.
 */
function checkPrinciple(concept: ReturnType<typeof parseConcept>, fields: ConceptFields, at: Report): void {
  if (!concept.hasFrontmatter) {
    at(1, "error", "This principle has no frontmatter, so the principle index shows only its path. Add a frontmatter block with a title and a description.");
    return;
  }
  if (concept.title.trim() === "") {
    at(1, "error", "title is missing, so the principle index shows only the path. Set title to the rule, in a few words.");
  }
  if (concept.description.trim() === "") {
    at(1, "error", "description is missing, so the model cannot tell when the rule applies. Set description to when the rule applies, in one line.");
  } else if (concept.description.trim().includes("\n")) {
    at(fields.keyLine("description"), "warning", "description spans more than one line, and the principle index prints it on one line. Write it as one line.");
  }
}

interface ConceptFields {
  /** Set when the OKF parser dropped the block, which stores the whole file
   * as the body with no title or description. */
  problem: FrontmatterProblem | null;
  keyLine(key: string): number | null;
  tagsNotList: boolean;
}

/** Lines and silent drops for an OKF memory file, read the way `parseConcept`
 * reads it: the same splitter and the same YAML options. */
function readConceptFields(raw: string): ConceptFields {
  const none: ConceptFields = { problem: null, keyLine: () => null, tagsNotList: false };
  if (!raw.startsWith("---\n") && !raw.startsWith("---\r\n")) return none;
  const split = splitFrontmatter(raw);
  if (split === null) {
    return {
      ...none,
      problem: {
        line: 1,
        severity: "error",
        message: 'The frontmatter opens with "---" and never closes, so Valet stores the whole file as the body, with no title or description. Add a line with only "---" after the last field.',
      },
    };
  }
  const lineCounter = new LineCounter();
  const doc = parseDocument(split.yamlText, { keepSourceTokens: true, strict: false, lineCounter });
  // `yamlText` starts on line 2 of the file.
  const fileLine = (offset: number) => 1 + lineCounter.linePos(offset).line;
  const yamlError = doc.errors[0];
  if (yamlError !== undefined) {
    return {
      ...none,
      problem: {
        line: fileLine(yamlError.pos[0]),
        severity: "error",
        message: `The frontmatter is not valid YAML, so Valet stores the whole file as the body, with no title or description: ${firstLine(yamlError.message)}. Fix the YAML.`,
      },
    };
  }
  if (doc.contents === null) return none;
  if (!isMap(doc.contents)) {
    return {
      ...none,
      problem: {
        line: 2,
        severity: "error",
        message: "The frontmatter is not a set of key: value fields, so Valet stores the whole file as the body. Write each field on its own line as key: value.",
      },
    };
  }
  const lines = keyLines(doc, fileLine);
  const tags = doc.contents.get("tags", true);
  return {
    problem: null,
    keyLine: (key) => lines.get(key) ?? null,
    tagsNotList: tags !== undefined && !isSeq(tags) && !isNullScalar(tags),
  };
}

// ─── Workflows ───────────────────────────────────────────────────────────

function checkWorkflows(
  blobs: SkillTreeEntry[],
  tree: ValidateTree,
  now: number,
  findings: ValidateFinding[],
  checked: ValidateReport["checked"],
): void {
  for (const entry of blobs) {
    if (entry.mode === SYMLINK_MODE) continue;
    const root = workflowRootFor(entry.path);
    if (root === null) continue;
    const raw = tree.read(entry.path);
    const result = readWorkflowFile(raw, entry.path, root, undefined);
    if (result.kind === "skip") continue;
    checked.workflows += 1;
    const at = (line: number, message: string) =>
      findings.push({ path: entry.path, line, severity: "error", kind: "workflow", message });

    const locate = workflowLocator(raw);
    if (result.kind === "warn") {
      for (const problem of result.problems) at(result.line ?? locate(problem), displayProblem(problem, entry.path));
      continue;
    }
    const schedule = result.file.schedule;
    if (schedule === undefined) continue;
    const next = nextFireAt(schedule.cron, schedule.timezone ?? "UTC", now);
    if (!next.ok) {
      at(locate('"schedule"'), `${next.error}. Fix the schedule, because sync mirrors nothing from a file whose schedule does not parse.`);
    }
  }
}

/**
 * The line a workflow problem points at. The validator names a node by id,
 * an edge or an event by index, or a top-level block by name, so the
 * locator finds that item in the YAML. A problem it cannot place gets the
 * file's first line.
 */
function workflowLocator(raw: string): (problem: string) => number {
  const lineCounter = new LineCounter();
  const doc = parseDocument(raw, { lineCounter });
  const lineOf = (node: unknown): number | null => {
    const offset = rangeOf(node);
    return offset === null ? null : lineCounter.linePos(offset).line;
  };
  const top = isMap(doc.contents) ? doc.contents : null;
  // A legacy file keeps the definition at the top level.
  const nested = top?.get("definition", true);
  const definition = isMap(nested) ? nested : top;
  const seq = (key: string) => {
    const node = definition?.get(key, true);
    return isSeq(node) ? node : null;
  };

  return (problem) => {
    // An edge message also names its nodes, so the edge goes first.
    const edge = /edges?\[(\d+)\]/.exec(problem);
    if (edge) {
      const line = lineOf(seq("edges")?.items[Number(edge[1])]);
      if (line !== null) return line;
    }
    const event = /events\[(\d+)\]/.exec(problem);
    const events = top?.get("events", true);
    if (event && isSeq(events)) {
      const line = lineOf(events.items[Number(event[1])]);
      if (line !== null) return line;
    }
    const node = /node(?: id)? "((?:[^"\\]|\\.)*)"/.exec(problem);
    if (node) {
      const matches = seq("nodes")?.items.filter((n) => isMap(n) && n.get("id") === node[1]) ?? [];
      // A duplicate id is the second node that uses it.
      const line = lineOf(problem.startsWith("duplicate") ? matches.at(-1) : matches[0]);
      if (line !== null) return line;
    }
    for (const key of ["schedule", "events", "definition", "valet"]) {
      if (!problem.includes(`"${key}"`) && !problem.includes(`${key}:`)) continue;
      const pair = top?.items.find((item) => isScalarLike(item.key) && item.key.value === key);
      const line = lineOf(pair?.key);
      if (line !== null) return line;
    }
    return 1;
  };
}

/**
 * A sync message names the file first; the report already does. The DAG
 * validator states the defect and stops, so a message with no closing
 * sentence gets one that says what follows from it.
 */
function displayProblem(problem: string, path: string): string {
  let text = problem;
  if (text.startsWith(`${path}: `)) text = text.slice(path.length + 2);
  else if (text.startsWith(`${path} `)) text = `This file ${text.slice(path.length + 1)}`;
  // A YAML error carries a code frame on the lines after the first.
  if (text.includes("\n")) return `${firstLine(text)}. Fix the YAML.`;
  if (!/[.!?]$/.test(text)) text += ". Fix the definition, because sync mirrors nothing from a file that fails this check.";
  return text;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/** True when `message` names `path` as a whole path, not as the tail of a
 * longer one. */
function mentions(message: string, path: string): boolean {
  let index = message.indexOf(path);
  while (index !== -1) {
    if (index === 0 || message.charAt(index - 1) === " ") return true;
    index = message.indexOf(path, index + 1);
  }
  return false;
}

function keyLines(doc: Document, fileLine: (offset: number) => number): Map<string, number> {
  return isMap(doc.contents) ? keyLinesOf(doc.contents, fileLine) : new Map();
}

function keyLinesOf(map: YAMLMap, fileLine: (offset: number) => number): Map<string, number> {
  const lines = new Map<string, number>();
  for (const pair of map.items) {
    const offset = rangeOf(pair.key);
    const key = String(isScalarLike(pair.key) ? pair.key.value : pair.key);
    if (offset !== null && !lines.has(key)) lines.set(key, fileLine(offset));
  }
  return lines;
}

/** The start offset of a YAML node, from its `range`. */
function rangeOf(node: unknown): number | null {
  if (typeof node !== "object" || node === null || !("range" in node)) return null;
  const range = node.range;
  return Array.isArray(range) && typeof range[0] === "number" ? range[0] : null;
}

function isScalarLike(node: unknown): node is { value: unknown } {
  return typeof node === "object" && node !== null && "value" in node;
}

function isNullScalar(node: unknown): boolean {
  return node === null || (isScalarLike(node) && node.value === null);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The text values of a frontmatter map, as the skill loader keeps them. */
function stringMap(value: unknown): Record<string, string> | undefined {
  if (!isPlainRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

function lineCount(text: string): number {
  return text.split("\n").length - 1;
}

/** The first line of a parser message, without the position the YAML
 * library appends: the finding carries the file line already, and the
 * library counts from the start of the frontmatter, not of the file. */
function firstLine(text: string): string {
  return (text.split("\n")[0] ?? "").replace(/[:.\s]+$/, "").replace(/ at line \d+, column \d+$/, "");
}
