/**
 * Unit tests for the slash-command host providers (skills-as-commands plan,
 * Task 4): `readRepoPromptSkills` parsing (SkillSource shape with `argHint`
 * and `invocation`) + no-sandbox / non-zero-exit fallbacks.
 *
 * The DB-backed pieces (`makeWorkspaceSkillsProvider` merge, `makeCommandContext`)
 * are exercised end to end through the route in `command-route.test.ts`.
 */
import { describe, expect, it } from "vitest";
import type { ExecOpts, ExecResult, Sandbox, SkillSource } from "@valet/engine";
import { makeWorkspaceSkillsProvider, readRepoPromptSkills } from "./command-providers.js";

/** Minimal `Sandbox` whose `exec` returns a canned result. Only `exec` is
 * called by `readRepoPromptSkills`; the rest throw if ever touched. */
function fakeSandbox(result: ExecResult): Sandbox {
  const unused = (): never => {
    throw new Error("not implemented in fakeSandbox");
  };
  return {
    id: "fake",
    exec: async (_command: string, _opts?: ExecOpts): Promise<ExecResult> => result,
    readFile: unused,
    readBinary: unused,
    writeFile: unused,
    writeBinary: unused,
    readdir: unused,
    stat: unused,
    mkdir: unused,
    rm: unused,
  };
}

describe("readRepoPromptSkills", () => {
  it("returns [] when no sandbox is available", async () => {
    expect(await readRepoPromptSkills(undefined)).toEqual([]);
  });

  it("returns [] on a non-zero exit", async () => {
    const sandbox = fakeSandbox({ stdout: "junk", stderr: "", exitCode: 1 });
    expect(await readRepoPromptSkills(sandbox)).toEqual([]);
  });

  it("parses one workspace prompt skill with description and argHint", async () => {
    const stdout =
      "===VALET-TMPL /workspace/.valet/prompts/standup.md\n" +
      "---\n" +
      'description: Daily standup\n' +
      'argHint: "<topic>"\n' +
      "---\n" +
      "Summarize $1\n";
    const skills = await readRepoPromptSkills(fakeSandbox({ stdout, stderr: "", exitCode: 0 }));
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      name: "standup",
      description: "Daily standup",
      source: "repo",
      invocation: "prompt",
      argHint: "<topic>",
    });
    expect(skills[0]?.content).toContain("Summarize $1");
  });

  it("defaults invocation to prompt and omits absent argHint/description", async () => {
    const stdout =
      "===VALET-TMPL /workspace/.valet/prompts/plan.md\n" + "Plan the work.\n";
    const skills = await readRepoPromptSkills(fakeSandbox({ stdout, stderr: "", exitCode: 0 }));
    expect(skills).toHaveLength(1);
    const skill = skills[0] as SkillSource;
    expect(skill.name).toBe("plan");
    expect(skill.invocation).toBe("prompt");
    expect(skill.argHint).toBeUndefined();
    expect(skill.description).toBeUndefined();
  });

  it("honors an explicit invocation: context override", async () => {
    const stdout =
      "===VALET-TMPL /workspace/.valet/prompts/brief.md\n" +
      "---\n" +
      "description: Team brief\n" +
      "invocation: context\n" +
      "---\n" +
      "Background material.\n";
    const skills = await readRepoPromptSkills(fakeSandbox({ stdout, stderr: "", exitCode: 0 }));
    expect(skills[0]).toMatchObject({
      name: "brief",
      description: "Team brief",
      invocation: "context",
      source: "repo",
    });
  });

  it("parses multiple prompt skills and names them from the basename", async () => {
    const stdout =
      "===VALET-TMPL /workspace/.valet/prompts/plan.md\n" +
      "Plan the work.\n" +
      "===VALET-TMPL /workspace/.valet/prompts/review.md\n" +
      "description: Review a PR\n" +
      "Review $ARGUMENTS\n";
    const skills = await readRepoPromptSkills(fakeSandbox({ stdout, stderr: "", exitCode: 0 }));
    expect(skills.map((s: SkillSource) => s.name)).toEqual(["plan", "review"]);
    expect(skills[0]?.description).toBeUndefined();
    expect(skills[1]?.description).toBe("Review a PR");
  });
});

describe("makeWorkspaceSkillsProvider", () => {
  it("returns empty when no sandbox is available", async () => {
    // No sandbox means no repo prompts — provider must return [].
    const provider = makeWorkspaceSkillsProvider(() => undefined);
    expect(await provider()).toEqual([]);
  });

  it("reads repo prompt skills when the sandbox accessor resolves one", async () => {
    const stdout =
      "===VALET-TMPL /workspace/.valet/prompts/deploy.md\n" +
      "description: Deploy the app\n" +
      "Deploy $1 to $2\n";
    const provider = makeWorkspaceSkillsProvider(() =>
      fakeSandbox({ stdout, stderr: "", exitCode: 0 }),
    );
    const skills = await provider();
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ name: "deploy", invocation: "prompt", source: "repo" });
  });
});
