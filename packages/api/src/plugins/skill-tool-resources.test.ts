/**
 * Unit coverage for the `skill` tool's resource materialization hook
 * (staged-files design, 2026-08-23, decision 7): a skill with resources
 * triggers the callback and the tool result names the root; a failure
 * degrades to a warning line in the same result; a resource-less skill
 * never calls the hook.
 */
import { describe, expect, it } from "vitest";
import type { Credential, CredentialProvider, Sandbox, SkillSource, ToolContext } from "@valet/engine";
import { buildSkillTool } from "./skill-tool.js";

const stubCredentials: CredentialProvider = {
  get: async (): Promise<Credential | null> => null,
  request: async (): Promise<Credential> => {
    throw new Error("not used");
  },
};

function stubSandbox(): Sandbox {
  return {
    id: "sb-stub",
    readFile: async () => "",
    readBinary: async () => new Uint8Array(),
    writeFile: async () => {},
    writeBinary: async () => {},
    readdir: async () => [],
    stat: async () => ({ isFile: false, isDirectory: false, size: 0 }),
    mkdir: async () => {},
    rm: async () => {},
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  };
}

function makeCtx(): ToolContext {
  return {
    userId: "user-1",
    orgId: "org-1",
    sessionId: "sess-1",
    threadId: "thread-1",
    credentials: stubCredentials,
    sandbox: stubSandbox(),
    requestDecision: async () => {
      throw new Error("not used");
    },
    signal: new AbortController().signal,
    threadRead: async () => [],
    listThreads: async () => [],
    setModel: async (args: { model: string }) => ({ fromModel: "none", toModel: args.model }),
  };
}

const bareSkill: SkillSource = {
  name: "plain",
  description: "No resources.",
  content: "Do the thing.",
  source: "plugin",
};

const bundledSkill: SkillSource = {
  name: "pdf-tools",
  description: "Ships a script.",
  content: "Run scripts/extract.py.",
  source: "plugin",
  resources: [{ path: "scripts/extract.py", data: new TextEncoder().encode("print('hi')\n") }],
  resourcesHash: "f".repeat(64),
};

describe("skill tool resource materialization", () => {
  it("materializes and names the root when the skill ships resources", async () => {
    const calls: string[] = [];
    const tool = buildSkillTool([bareSkill, bundledSkill], {
      materializeResources: async (skill) => {
        calls.push(skill.name);
        return "/workspace/.valet/skills/pdf-tools";
      },
    });
    const result = await tool!.execute({ name: "pdf-tools" }, makeCtx());
    expect(calls).toEqual(["pdf-tools"]);
    expect(result.text).toContain("/workspace/.valet/skills/pdf-tools");
    expect(result.text).toContain("Run scripts/extract.py.");
  });

  it("never calls the hook for a skill without resources", async () => {
    const calls: string[] = [];
    const tool = buildSkillTool([bareSkill, bundledSkill], {
      materializeResources: async (skill) => {
        calls.push(skill.name);
        return "/unused";
      },
    });
    const result = await tool!.execute({ name: "plain" }, makeCtx());
    expect(calls).toEqual([]);
    expect(result.text).toBe("Do the thing.");
  });

  it("degrades to a warning in the tool result when materialization fails", async () => {
    const tool = buildSkillTool([bundledSkill], {
      materializeResources: async () => {
        throw new Error("sandbox unreachable");
      },
    });
    const result = await tool!.execute({ name: "pdf-tools" }, makeCtx());
    expect(result.text).toContain("sandbox unreachable");
    expect(result.text).toContain("Run scripts/extract.py.");
    expect(result.text).not.toContain("/workspace/.valet/skills");
  });

  it("keeps the exact previous behavior when no hook is wired", async () => {
    const tool = buildSkillTool([bundledSkill]);
    const result = await tool!.execute({ name: "pdf-tools" }, makeCtx());
    expect(result.text).toBe("Run scripts/extract.py.");
  });
});
