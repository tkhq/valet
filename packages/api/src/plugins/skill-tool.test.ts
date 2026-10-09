/**
 * Unit tests for the `skill` tool's construction. The end-to-end behaviour
 * (a real session, real plugin skills) lives in
 * `src/engine/host.skill-tool.test.ts`; this file covers the contract
 * `buildSkillTool` holds with its callers.
 */
import { describe, it, expect, vi } from "vitest";
import type { Sandbox, SkillSource, ToolContext } from "@valet/engine";
import { buildSkillTool, type SkillToolSession } from "./skill-tool.js";

function skill(name: string, content: string): SkillSource {
  return { name, description: `Does ${name}.`, content, source: "plugin" };
}

describe("buildSkillTool", () => {
  it("returns null when the plugin set ships no skills", () => {
    expect(buildSkillTool([])).toBeNull();
  });

  it("builds a tool over the skills it is given", () => {
    const tool = buildSkillTool([skill("deploy", "Deploy body.")]);
    expect(tool?.name).toBe("skill");
    expect(tool?.description).toContain("deploy");
  });

  // The name index is a Map, and a Map built from pairs keeps the LAST
  // value for a repeated key. Callers deduplicate before this point, so a
  // duplicate here means that guard was bypassed. Silently serving one
  // skill's body under another's name is the worst available outcome, so
  // this refuses instead.
  it("refuses a list that holds the same name twice", () => {
    expect(() =>
      buildSkillTool([skill("deploy", "First body."), skill("deploy", "Second body.")]),
    ).toThrow(/deploy/);
  });

  describe("bound to a session", () => {
    // No invocation recorder is wired, so `execute` reads nothing from the
    // context. Only the sandbox id is filled in; a full fake Sandbox is noise.
    const sandbox: Partial<Sandbox> & { id: string } = { id: "sb-1" };
    const ctx: ToolContext = {
      userId: "u1",
      orgId: "o1",
      sessionId: "s1",
      threadId: "t1",
      credentials: { get: async () => null, request: async () => Promise.reject(new Error("unused")) },
      sandbox: sandbox as Sandbox,
      requestDecision: async () => Promise.reject(new Error("unused")),
      signal: new AbortController().signal,
      threadRead: async () => [],
      listThreads: async () => [],
      setModel: async ({ model }) => ({ fromModel: model, toModel: model }),
    };

    function fakeSession(initial: SkillSource[], next: SkillSource[] = initial) {
      const skills = new Map(initial.map((s) => [s.name, s]));
      let refreshes = 0;
      const session: SkillToolSession = {
        skills,
        refreshSkills: async () => {
          refreshes++;
          skills.clear();
          for (const s of next) skills.set(s.name, s);
        },
      };
      return { session, refreshes: () => refreshes };
    }

    it("describes and serves the session's current skills, not the build list", async () => {
      const { session } = fakeSession([skill("deploy", "Deploy v2."), skill("slides", "Slides body.")]);
      const tool = buildSkillTool([skill("deploy", "Deploy v1.")], () => session);
      expect(tool?.description).toContain("slides");
      expect((await tool!.execute({ name: "deploy" }, ctx)).text).toBe("Deploy v2.");
    });

    it("re-reads the session's skills once for an unknown name", async () => {
      const { session, refreshes } = fakeSession([skill("deploy", "Deploy.")], [skill("deploy", "Deploy."), skill("slides", "Slides body.")]);
      const tool = buildSkillTool([skill("deploy", "Deploy.")], () => session);
      expect((await tool!.execute({ name: "slides" }, ctx)).text).toBe("Slides body.");
      expect(refreshes()).toBe(1);
      await tool!.execute({ name: "deploy" }, ctx);
      expect(refreshes()).toBe(1);
    });

    it("answers from the previous skills when the re-read fails", async () => {
      const session: SkillToolSession = {
        skills: new Map([["deploy", skill("deploy", "Deploy.")]]),
        refreshSkills: async () => {
          throw new Error("db unavailable");
        },
      };
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const tool = buildSkillTool([skill("deploy", "Deploy.")], () => session);
      const result = await tool!.execute({ name: "slides" }, ctx);
      error.mockRestore();
      expect(result.text).toContain("[skill_not_found]");
      expect(result.text).toContain("deploy");
    });
  });
});
