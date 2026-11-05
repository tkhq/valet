import { describe, expect, it } from "vitest";
import { validateRepository, type ValidateFinding } from "./brain-validate.js";

/** An in-memory repository: path → content. A `null` content is a symlink. */
function check(files: Record<string, string | null>, subpath = "") {
  const entries = Object.keys(files).sort().map((path) => ({
    path,
    type: "blob",
    mode: files[path] === null ? "120000" : "100644",
    sha: "",
  }));
  return validateRepository(
    {
      entries,
      read: (path) => {
        const text = files[path];
        if (text === undefined || text === null) throw new Error(`unexpected read of ${path}`);
        return text;
      },
    },
    { subpath, now: Date.UTC(2026, 9, 30) },
  );
}

const skill = (name: string, extra = "") => `---\nname: ${name}\ndescription: Does ${name}.\n${extra}---\n\nBody.\n`;
const brief = (f: ValidateFinding) => `${f.path}:${f.line ?? "-"} ${f.severity} ${f.kind}`;

describe("validateRepository: skill discovery", () => {
  it("reports a SKILL.md at the top of the scan", () => {
    const report = check({ "SKILL.md": skill("root") });
    expect(report.findings.map(brief)).toEqual(["SKILL.md:- error skill"]);
    expect(report.findings[0]?.message).toContain("Move it into a directory named for the skill");
  });

  it("warns on the copy that .valet/skills outranks, and imports the .valet/skills one", () => {
    const report = check({
      ".valet/skills/deploy/SKILL.md": skill("deploy"),
      "skills/deploy/SKILL.md": skill("deploy"),
    });
    expect(report.findings.map(brief)).toEqual(["skills/deploy/SKILL.md:- warning skill"]);
    expect(report.checked.skills).toBe(1);
  });

  it("reports the prompt that loses to a skill of the same name", () => {
    const report = check({ "skills/standup/SKILL.md": skill("standup"), "prompts/standup.md": "Say hi.\n" });
    expect(report.findings.map(brief)).toEqual(["prompts/standup.md:- error prompt"]);
  });

  it("does not pair a path with a longer path that ends the same way", () => {
    const report = check({ "a/dup/SKILL.md": skill("dup"), "x/a/dup/SKILL.md": skill("dup") });
    expect(report.findings.map(brief)).toEqual(["a/dup/SKILL.md:- error skill"]);
  });

  it("warns on a skill under a directory sync does not scan", () => {
    const report = check({ "tests/fixture/SKILL.md": skill("fixture") });
    expect(report.findings.map(brief)).toEqual(["tests/fixture/SKILL.md:- warning skill"]);
    expect(report.checked.skills).toBe(0);
  });

  it("fails the repository past the sync's skill cap", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 301; i++) files[`skills/s${i}/SKILL.md`] = skill(`s${i}`);
    const report = check(files);
    expect(report.findings[0]).toMatchObject({ path: ".", kind: "repository", severity: "error" });
  });

  it("skips a symbolic link, as sync does", () => {
    expect(check({ "skills/linked/SKILL.md": null }).checked.skills).toBe(0);
  });
});

describe("validateRepository: skill files", () => {
  it("warns at the field line when the parser drops a list or a nested map", () => {
    const report = check({
      "skills/tidy/SKILL.md": "---\nname: tidy\ndescription: Tidies.\nallowed-tools: [Read, Grep]\nmetadata:\n  author: me\n  tags: [a, b]\n---\n",
    });
    expect(report.findings.map((f) => `${f.line} ${f.severity} ${f.message.split(",")[0]}`)).toEqual([
      "4 warning allowed-tools is a list or a nested map",
      "7 warning metadata.tags is a list or a nested map",
    ]);
  });

  it("reports a metadata.kind that is not exactly playbook", () => {
    const report = check({ "skills/pb/SKILL.md": skill("pb", "metadata:\n  kind: Playbook\n") });
    expect(report.findings.map(brief)).toEqual(["skills/pb/SKILL.md:4 error skill"]);
    expect(report.findings[0]?.message).toContain('metadata.kind is "Playbook"');
  });

  it("reports an advisory as a warning, because sync still imports the skill", () => {
    const long = "x".repeat(1100);
    const report = check({ "skills/long/SKILL.md": `---\nname: long\ndescription: ${long}\n---\n` });
    expect(report.findings.map(brief)).toEqual(["skills/long/SKILL.md:3 warning skill"]);
    expect(report.errors).toBe(0);
  });

  it("reports a prompt whose invocation sync cannot read", () => {
    const report = check({ "prompts/hello.md": "---\ninvocation: always\n---\nSay hi.\n" });
    expect(report.findings.map(brief)).toEqual(["prompts/hello.md:2 error prompt"]);
  });

  it("counts a valid playbook and reports nothing", () => {
    const report = check({
      "skills/ship/SKILL.md": skill("ship", "metadata:\n  kind: playbook\n").replace("Body.", "## Steps\n\n1. Build\n2. Ship"),
    });
    expect(report.findings).toEqual([]);
    expect(report.checked.playbooks).toBe(1);
  });

  it("points a playbook with no Steps heading at its metadata field", () => {
    const report = check({ "skills/pb/SKILL.md": skill("pb", "metadata:\n  kind: playbook\n") });
    expect(report.findings.map(brief)).toEqual(["skills/pb/SKILL.md:4 error playbook"]);
  });
});

describe("validateRepository: memory files and principles", () => {
  it("warns on a file sync does not mirror", () => {
    const report = check({ ".valet/memory/notes/diagram.png": "png" });
    expect(report.findings.map(brief)).toEqual([".valet/memory/notes/diagram.png:- warning memory"]);
  });

  it("reports a path the memory store refuses", () => {
    const report = check({ ".valet/memory/notes/2026-10-30: retro.md": "Notes.\n" });
    expect(report.findings[0]).toMatchObject({ severity: "error", kind: "memory" });
    expect(report.findings[0]?.message).toContain("colons are not allowed");
  });

  it("warns on fields the OKF parser drops or does not read", () => {
    const report = check({
      ".valet/memory/notes/a.md": "---\ntitle: A\ntags: deploys\nvalet:\n  sensitivity: public\n  pinned: true\n---\nBody.\n",
    });
    expect(report.findings.map((f) => `${f.line} ${f.severity} ${f.message.split(" ").slice(0, 2).join(" ")}`)).toEqual([
      "3 warning tags is",
      "4 warning valet.pinned is",
      "4 warning valet.sensitivity is",
    ]);
  });

  it("warns on a principle description that spans lines", () => {
    const report = check({
      ".valet/memory/principles/p.md": "---\ntitle: P\ndescription: |\n  first\n  second\n---\nRule.\n",
    });
    expect(report.findings.map(brief)).toEqual([".valet/memory/principles/p.md:3 warning principle"]);
  });

  it("reports a principle with no title", () => {
    const report = check({ ".valet/memory/principles/p.md": "---\ndescription: When it applies.\n---\nRule.\n" });
    expect(report.findings.map(brief)).toEqual([".valet/memory/principles/p.md:1 error principle"]);
    expect(report.findings[0]?.message).toContain("title is missing");
  });
});

describe("validateRepository: workflows", () => {
  const workflow = (nodes: string, rest = "") =>
    `valet: workflow/v1\nname: W\ndefinition:\n  version: dag/v1\n  nodes:\n${nodes}  edges:\n    - from: trigger\n      to: done\n${rest}`;
  const nodes = "    - id: trigger\n      type: trigger\n    - id: done\n      type: stop\n";

  it("points a node error at the node", () => {
    const report = check({
      ".valet/workflows/w.yaml": workflow(`${nodes}    - id: done\n      type: stop\n`),
    });
    expect(report.findings.map(brief)).toEqual([".valet/workflows/w.yaml:10 error workflow"]);
    expect(report.findings[0]?.message).toContain('duplicate node id "done"');
  });

  it("points an event error at the event", () => {
    const report = check({ ".valet/workflows/w.yaml": workflow(nodes, "events:\n  - name: On push\n") });
    expect(report.findings.map(brief)).toEqual([".valet/workflows/w.yaml:14 error workflow"]);
    expect(report.findings[0]?.message).toContain('needs an "eventKeys" list');
  });

  it("reports an unknown timezone at the schedule", () => {
    const report = check({
      ".valet/workflows/w.yaml": workflow(nodes, "schedule:\n  cron: \"0 3 * * *\"\n  timezone: Mars/Base\n"),
    });
    expect(report.findings.map(brief)).toEqual([".valet/workflows/w.yaml:13 error workflow"]);
    expect(report.findings[0]?.message).toContain('Unknown timezone "Mars/Base"');
  });

  it("reports a file with no workflow under .valet/workflows, and skips one under workflows/", () => {
    const report = check({ ".valet/workflows/notes.yaml": "hello: world\n", "workflows/ci.yaml": "jobs: {}\n" });
    expect(report.findings.map(brief)).toEqual([".valet/workflows/notes.yaml:1 error workflow"]);
    expect(report.checked.workflows).toBe(1);
  });
});
