import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExitCode } from "../exit.js";
import { parseGlobalFlags } from "../output.js";
import { runArtifacts, type ArtifactsClient } from "./artifacts.js";
import { runMemory, type MemoryClient } from "./memory.js";
import type { ShareArtifactRequest } from "../../wire/types.js";

beforeEach(() => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => vi.restoreAllMocks());

describe("valet artifacts publish", () => {
  function fake() {
    const shared: Array<{ body: ShareArtifactRequest; workspace?: string }> = [];
    const client: ArtifactsClient = {
      listArtifacts: async () => ({ artifacts: [] }),
      shareArtifact: async (body, workspace) => {
        shared.push({ body, workspace });
        return { id: "a1", path: body.key ?? "", url: "https://valet.test/a/x", version: 1, visibility: "org", updatedAt: 1 };
      },
      revokeArtifact: async () => undefined,
    };
    return { shared, deps: { client, readSource: async () => "# Report" } };
  }

  it("keys the page by the file name and infers html from the extension", async () => {
    const { deps, shared } = fake();
    expect(await runArtifacts(deps, parseGlobalFlags(["publish", "out/weekly-report.html", "--workspace", "team-1"]))).toBe(ExitCode.OK);
    expect(shared).toEqual([{ body: { key: "weekly-report", content: "# Report", format: "html" }, workspace: "team-1" }]);
  });

  it("needs --key from stdin and refuses an unknown --format", async () => {
    expect(await runArtifacts(fake().deps, parseGlobalFlags(["publish", "-"]))).toBe(ExitCode.Usage);
    expect(await runArtifacts(fake().deps, parseGlobalFlags(["publish", "a.md", "--format", "pdf"]))).toBe(ExitCode.Usage);
  });
});

describe("valet memory", () => {
  it("patch with an empty --new deletes the passage, and write refuses empty content", async () => {
    const patches: Array<{ oldString: string; newString: string }> = [];
    const client: MemoryClient = {
      searchMemory: async () => ({ results: [] }),
      readMemory: async () => ({}),
      writeMemory: async () => ({}),
      patchMemory: async (body) => { patches.push(body); return {}; },
      moveMemory: async () => undefined,
      deleteMemory: async () => undefined,
    };
    expect(await runMemory({ client, readSource: async () => "" }, parseGlobalFlags(["patch", "a.md", "--old", "draft", "--new"]))).toBe(ExitCode.OK);
    expect(patches).toEqual([{ path: "a.md", oldString: "draft", newString: "" }]);
    expect(await runMemory({ client, readSource: async () => "  " }, parseGlobalFlags(["write", "a.md", "--file", "x.md"]))).toBe(ExitCode.Usage);
  });
});
