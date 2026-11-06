import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { ExitCode } from "../exit.js";
import { listTree, runValidate } from "./validate.js";

const FIXTURES = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../test/fixtures/validate");
const CLEAN = join(FIXTURES, "clean-brain");
const BROKEN = join(FIXTURES, "broken-brain");
// A fixed clock keeps the cron check deterministic.
const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);

let outSpy: MockInstance;
let errSpy: MockInstance;
beforeEach(() => {
  outSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
});
afterEach(() => vi.restoreAllMocks());
const stdout = (): string => outSpy.mock.calls.map((c) => String(c[0])).join("");
const stderr = (): string => errSpy.mock.calls.map((c) => String(c[0])).join("");

describe("valet validate on a clean repository", () => {
  it("checks every kind and exits 0", async () => {
    expect(await runValidate([CLEAN], { now: NOW })).toBe(ExitCode.OK);
    expect(stdout()).toBe(
      "Checked 2 skills (1 playbook), 1 prompt, 1 principle, 1 other memory file, and 1 workflow.\n0 errors, 0 warnings.\n",
    );
  });

  it("skips a file under a top-level workflows/ folder that is not a workflow", async () => {
    await runValidate([CLEAN, "--json"], { now: NOW });
    const report = JSON.parse(stdout());
    expect(report.checked.workflows).toBe(1);
    expect(report.findings).toEqual([]);
  });
});

describe("valet validate on a broken repository", () => {
  it("reports each problem at its file and line, and exits 1", async () => {
    expect(await runValidate([BROKEN], { now: NOW })).toBe(ExitCode.Failure);
    const lines = stdout().split("\n");
    const at = (prefix: string) => lines.find((line) => line.startsWith(prefix));

    // Skills and playbooks first.
    expect(at("skills/long-playbook/SKILL.md:30: error:")).toContain("It has 21 steps. A plan holds at most 20.");
    expect(at("skills/wordy-playbook/SKILL.md:11: error:")).toContain("Step 2 is longer than 200 characters.");
    expect(at("skills/no-steps/SKILL.md:4: error:")).toContain('Add a "## Steps" heading');
    expect(at("skills/flat-kind/SKILL.md:4: error:")).toContain("Move it under metadata");
    expect(at("skills/no-description/SKILL.md:1: error:")).toContain("description is required");
    expect(at("skills/wrong-name/SKILL.md:2: error:")).toContain('does not match the directory name "wrong-name"');
    expect(at("skills/bad-yaml/SKILL.md:4: error:")).toContain("is not valid YAML");
    expect(at("skills/unclosed/SKILL.md:1: error:")).toContain("never closes");
    expect(at("more/dup/SKILL.md: error:")).toContain("Valet imported neither");
    // A YAML error hides the field errors that follow from it.
    expect(lines.filter((line) => line.startsWith("skills/bad-yaml/"))).toHaveLength(1);

    // Then principles and memory files.
    expect(at(".valet/memory/principles/no-frontmatter.md:1: error:")).toContain("no frontmatter");
    expect(at(".valet/memory/principles/no-description.md:1: error:")).toContain("description is missing");
    expect(at(".valet/memory/index.md: error:")).toContain("use overview.md instead");
    expect(at(".valet/memory/notes/broken.md:3: error:")).toContain("is not valid YAML");

    // Then workflows.
    expect(at(".valet/workflows/bad-cron.yaml:13: error:")).toContain("cron must be a 5-field expression");
    expect(at(".valet/workflows/bad-edge.yaml:11: error:")).toContain('unknown target node "missing". Fix the definition');
    expect(at(".valet/workflows/not-yaml.yaml:3: error:")).toContain("not valid YAML or JSON");
    expect(at(".valet/workflows/template.yaml:1: error:")).toContain("Move it to .valet/templates/");

    expect(stdout()).toContain("17 errors, 0 warnings.");
    const order = ["skills/wrong-name/", ".valet/memory/index.md", ".valet/workflows/bad-cron.yaml"]
      .map((prefix) => lines.findIndex((line) => line.startsWith(prefix)));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("prints the same findings as JSON", async () => {
    expect(await runValidate([BROKEN, "--json"], { now: NOW })).toBe(ExitCode.Failure);
    const report = JSON.parse(stdout());
    expect(report.errors).toBe(17);
    expect(report.findings).toContainEqual(expect.objectContaining({
      path: "skills/long-playbook/SKILL.md",
      line: 30,
      severity: "error",
      kind: "playbook",
    }));
  });

  it("narrows the skill scan with --subpath and still checks .valet/", async () => {
    expect(await runValidate([BROKEN, "--subpath", "more", "--json"], { now: NOW })).toBe(ExitCode.Failure);
    const report = JSON.parse(stdout());
    expect(report.checked.skills).toBe(1);
    expect(report.findings.some((f: { path: string }) => f.path.startsWith("skills/"))).toBe(false);
    expect(report.checked.workflows).toBe(4);
  });
});

describe("valet validate usage", () => {
  it("prints help and exits 0", async () => {
    expect(await runValidate(["--help"])).toBe(ExitCode.OK);
    expect(stdout()).toContain("valet validate [path] [options]");
  });

  it("exits 2 when the path is not a directory", async () => {
    expect(await runValidate([join(CLEAN, "missing")])).toBe(ExitCode.Usage);
    expect(stderr()).toContain("is not a directory. Pass the root of the repository to check.");
  });

  it("exits 2 on a second path", async () => {
    expect(await runValidate([CLEAN, BROKEN])).toBe(ExitCode.Usage);
  });
});

describe("listTree", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "valet-validate-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("lists files as git blobs, marks links, and skips .git and node_modules", () => {
    mkdirSync(join(dir, "skills/real"), { recursive: true });
    writeFileSync(join(dir, "skills/real/SKILL.md"), "---\nname: real\ndescription: Real.\n---\n");
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".git/HEAD"), "ref: refs/heads/main\n");
    mkdirSync(join(dir, "node_modules/pkg/skill"), { recursive: true });
    writeFileSync(join(dir, "node_modules/pkg/skill/SKILL.md"), "x");
    mkdirSync(join(dir, "skills/linked"));
    symlinkSync(join(dir, "skills/real/SKILL.md"), join(dir, "skills/linked/SKILL.md"));

    expect(listTree(dir)).toEqual([
      { path: "skills/linked/SKILL.md", type: "blob", mode: "120000", sha: "" },
      { path: "skills/real/SKILL.md", type: "blob", mode: "100644", sha: "" },
    ]);
  });
});
