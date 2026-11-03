/**
 * `valet validate [path]` — check a brain repository before it merges: the
 * skills, playbooks, prompts, principles, memory files, and workflows that
 * content sync reads from it. It needs no instance and no sign-in.
 *
 * The checks live in `../brain-validate.ts`. This module lists the files of
 * a local checkout the way a git tree lists them, prints the findings as
 * `path:line: severity: message`, and exits 1 when any finding is an error,
 * so CI can block the merge.
 *
 * The listing walks the working tree, not the git index, so a file you have
 * not committed is checked too. It skips `.git` and `node_modules`, which a
 * pushed tree does not hold.
 */
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { validateRepository, type ValidateReport } from "../brain-validate.js";
import { ExitCode } from "../exit.js";
import { parseGlobalFlags, printErr, printJson, printLine } from "../output.js";
import type { SkillTreeEntry } from "../../services/skill-repo-reader.js";
import type { CliContext } from "../types.js";

const USAGE = `valet validate [path] [options]

Check a brain repository with the rules Valet sync applies to it: SKILL.md
files and playbooks, prompts, principles and other files under
.valet/memory/, and workflows under .valet/workflows/ or workflows/.

Arguments:
  path              The repository root (default: the current directory)

Options:
  --subpath <dir>   Scan only the skills under <dir>, as a source with a
                    subdirectory does
  --json            Print the report as JSON

Exit codes: 0 no errors, 1 one or more errors, 2 usage error.`;

/** Directories a pushed tree does not hold. */
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules"]);

export interface ValidateDeps {
  /** Clock for the cron check. */
  now?: number;
}

export async function runValidate(args: string[], deps: ValidateDeps = {}): Promise<number> {
  const { flags, rest, json } = parseGlobalFlags(args.map((arg) => (arg === "-h" ? "--help" : arg)));
  if (flags.help === true) {
    printLine(USAGE);
    return ExitCode.OK;
  }
  if (rest.length > 1 || (flags.subpath !== undefined && typeof flags.subpath !== "string")) {
    printErr(USAGE);
    return ExitCode.Usage;
  }
  const root = resolve(rest[0] ?? ".");
  let isDirectory = false;
  try {
    isDirectory = lstatSync(root).isDirectory();
  } catch {
    // Reported below.
  }
  if (!isDirectory) {
    printErr(`valet validate: ${root} is not a directory. Pass the root of the repository to check.`);
    return ExitCode.Usage;
  }

  const report = validateRepository(
    { entries: listTree(root), read: (path) => readFileSync(join(root, path), "utf8") },
    { subpath: typeof flags.subpath === "string" ? flags.subpath : "", now: deps.now },
  );
  if (json) printJson(report);
  else printReport(report);
  return report.errors > 0 ? ExitCode.Failure : ExitCode.OK;
}

export async function run(args: string[], _ctx: CliContext): Promise<number> {
  return runValidate(args);
}

/**
 * Every file under `root` as a git tree entry. A symbolic link gets git's
 * link mode, so the checks skip it as sync does, and the walk never follows
 * one. The checks read no sha, so it stays empty.
 */
export function listTree(root: string): SkillTreeEntry[] {
  const entries: SkillTreeEntry[] = [];
  const walk = (relative: string) => {
    const dirents = readdirSync(join(root, relative), { withFileTypes: true });
    for (const dirent of dirents) {
      const path = relative ? `${relative}/${dirent.name}` : dirent.name;
      if (dirent.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(dirent.name)) walk(path);
      } else if (dirent.isSymbolicLink()) {
        entries.push({ path, type: "blob", mode: "120000", sha: "" });
      } else if (dirent.isFile()) {
        entries.push({ path, type: "blob", mode: "100644", sha: "" });
      }
    }
  };
  walk("");
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function printReport(report: ValidateReport): void {
  for (const finding of report.findings) {
    const where = finding.line === null ? finding.path : `${finding.path}:${finding.line}`;
    printLine(`${where}: ${finding.severity}: ${finding.message}`);
  }
  const { checked } = report;
  if (report.findings.length > 0) printLine("");
  printLine(
    `Checked ${count(checked.skills, "skill")} (${count(checked.playbooks, "playbook")}), ${count(checked.prompts, "prompt")}, ` +
      `${count(checked.principles, "principle")}, ${count(checked.memories, "other memory file", "other memory files")}, ` +
      `and ${count(checked.workflows, "workflow")}.`,
  );
  printLine(`${count(report.errors, "error")}, ${count(report.warnings, "warning")}.`);
}

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
