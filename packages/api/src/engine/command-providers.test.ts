/**
 * Unit tests for the slash-command host providers (Task 10):
 * `readRepoTemplates` parsing + no-sandbox / non-zero-exit fallbacks.
 *
 * The DB-backed pieces (`makeWorkspaceSkillsProvider` merge, `makeCommandContext`)
 * are exercised end to end through the route in `command-route.test.ts`.
 */
import { describe, expect, it } from "vitest";
import type { ExecOpts, ExecResult, Sandbox } from "@valet/engine";
import { makeWorkspaceSkillsProvider, readRepoTemplates } from "./command-providers.js";

/** Minimal `Sandbox` whose `exec` returns a canned result. Only `exec` is
 * called by `readRepoTemplates`; the rest throw if ever touched. */
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

describe("readRepoTemplates", () => {
  it("returns [] when no sandbox is available", async () => {
    expect(await readRepoTemplates(undefined)).toEqual([]);
  });

  it("returns [] on a non-zero exit", async () => {
    const sandbox = fakeSandbox({ stdout: "junk", stderr: "", exitCode: 1 });
    expect(await readRepoTemplates(sandbox)).toEqual([]);
  });

  it("parses one template with a frontmatter description", async () => {
    const stdout =
      "===VALET-TMPL /workspace/.valet/prompts/standup.md\n" +
      "---\n" +
      "description: Daily standup\n" +
      "---\n" +
      "Summarize $1\n";
    const templates = await readRepoTemplates(fakeSandbox({ stdout, stderr: "", exitCode: 0 }));
    expect(templates).toHaveLength(1);
    expect(templates[0]).toMatchObject({
      name: "standup",
      description: "Daily standup",
      source: "repo",
      invocation: "prompt",
    });
    expect(templates[0]?.content).toContain("Summarize $1");
  });

  it("parses multiple templates and names them from the basename", async () => {
    const stdout =
      "===VALET-TMPL /workspace/.valet/prompts/plan.md\n" +
      "Plan the work.\n" +
      "===VALET-TMPL /workspace/.valet/prompts/review.md\n" +
      "description: Review a PR\n" +
      "Review $ARGUMENTS\n";
    const templates = await readRepoTemplates(fakeSandbox({ stdout, stderr: "", exitCode: 0 }));
    expect(templates.map((t) => t.name)).toEqual(["plan", "review"]);
    expect(templates[0]?.description).toBeUndefined();
    expect(templates[1]?.description).toBe("Review a PR");
  });
});

describe("makeWorkspaceSkillsProvider", () => {
  it("returns empty when no sandbox is available", async () => {
    // No sandbox means no repo prompts — provider must return [].
    const provider = makeWorkspaceSkillsProvider(() => undefined);
    expect(await provider()).toEqual([]);
  });
});
