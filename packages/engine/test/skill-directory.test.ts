import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkillFromDirectory } from "../src/roles-skills/directory.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "skill-dir-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeSkill(name: string, files: Record<string, string | Uint8Array>): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: A test skill for directory loading.\n---\n\nRun scripts/run.sh.\n`,
  );
  for (const [rel, content] of Object.entries(files)) {
    const target = join(dir, rel);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content);
  }
  return dir;
}

describe("loadSkillFromDirectory", () => {
  it("loads SKILL.md and collects resource files with skill-root-relative paths", async () => {
    const dir = await writeSkill("pdf-tools", {
      "scripts/run.sh": "#!/bin/sh\necho ok\n",
      "references/REFERENCE.md": "detail\n",
      "assets/logo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    });

    const skill = loadSkillFromDirectory(dir, "plugin");

    expect(skill.name).toBe("pdf-tools");
    expect(skill.content).toContain("Run scripts/run.sh.");
    const paths = (skill.resources ?? []).map((r) => r.path).sort();
    expect(paths).toEqual(["assets/logo.png", "references/REFERENCE.md", "scripts/run.sh"]);
    const script = skill.resources?.find((r) => r.path === "scripts/run.sh");
    expect(new TextDecoder().decode(script?.data)).toBe("#!/bin/sh\necho ok\n");
    const png = skill.resources?.find((r) => r.path === "assets/logo.png");
    expect([...(png?.data ?? [])]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("returns no resources for a skill directory holding only SKILL.md", async () => {
    const dir = await writeSkill("bare", {});
    const skill = loadSkillFromDirectory(dir, "plugin");
    expect(skill.resources).toBeUndefined();
    expect(skill.resourcesHash).toBeUndefined();
  });

  it("computes a resourcesHash that is stable across load order and changes with content", async () => {
    const dir = await writeSkill("hashed", {
      "scripts/a.sh": "a\n",
      "scripts/b.sh": "b\n",
    });
    const first = loadSkillFromDirectory(dir, "plugin");
    const second = loadSkillFromDirectory(dir, "plugin");
    expect(first.resourcesHash).toBeDefined();
    expect(first.resourcesHash).toBe(second.resourcesHash);

    await writeFile(join(dir, "scripts/a.sh"), "changed\n");
    const third = loadSkillFromDirectory(dir, "plugin");
    expect(third.resourcesHash).not.toBe(first.resourcesHash);
  });

  it("rejects a skill whose resources exceed the per-skill byte cap", async () => {
    const dir = await writeSkill("too-big", {
      "assets/blob.bin": new Uint8Array(5 * 1024 * 1024 + 1),
    });
    expect(() => loadSkillFromDirectory(dir, "plugin")).toThrow(/too-big.*5 MiB|5 MiB.*too-big/s);
  });

  it("rejects a skill with more resource files than the cap", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 65; i++) files[`references/f${i}.md`] = `${i}\n`;
    const dir = await writeSkill("too-many", files);
    expect(() => loadSkillFromDirectory(dir, "plugin")).toThrow(/too-many.*64|64.*too-many/s);
  });

  it("enforces the name-matches-directory rule from the markdown loader", async () => {
    const dir = join(root, "actual-dir");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "SKILL.md"),
      "---\nname: other-name\ndescription: Mismatched name.\n---\n\nBody.\n",
    );
    expect(() => loadSkillFromDirectory(dir, "plugin")).toThrow(/other-name|actual-dir/);
  });
});
