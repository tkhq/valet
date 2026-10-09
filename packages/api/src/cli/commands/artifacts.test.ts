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
    expect(await runArtifacts(deps, parseGlobalFlags(["publish", "out/weekly-report.html"]))).toBe(ExitCode.OK);
    expect(shared).toEqual([{ body: { key: "weekly-report", content: "# Report", format: "html" }, workspace: undefined }]);
  });

  // Two teammates' svc-a/README.md and svc-b/README.md would both default to "README".
  it("does not let an empty --workspace skip the team --key guard", async () => {
    const { deps, shared } = fake();
    expect(await runArtifacts(deps, parseGlobalFlags(["publish", "svc-b/README.md", "--workspace", ""]))).toBe(ExitCode.Usage);
    expect(shared).toEqual([]);
  });

  it("needs --key for a team publish", async () => {
    const { deps, shared } = fake();
    expect(await runArtifacts(deps, parseGlobalFlags(["publish", "svc-b/README.md", "--workspace", "team-1"]))).toBe(ExitCode.Usage);
    expect(shared).toEqual([]);
    expect(await runArtifacts(deps, parseGlobalFlags(["publish", "svc-b/README.md", "--workspace", "team-1", "--key", "svc-b/readme"]))).toBe(ExitCode.OK);
    expect(shared[0]?.body.key).toBe("svc-b/readme");
  });

  it("needs --key from stdin and refuses an unknown --format", async () => {
    expect(await runArtifacts(fake().deps, parseGlobalFlags(["publish", "-"]))).toBe(ExitCode.Usage);
    expect(await runArtifacts(fake().deps, parseGlobalFlags(["publish", "a.md", "--format", "pdf"]))).toBe(ExitCode.Usage);
  });
});

describe("valet memory", () => {
  // An unset $TEAM_ID must not send a team delete to the personal workspace.
  it("refuses an empty or bare --workspace before any write", async () => {
    const calls: string[] = [];
    const client: MemoryClient = {
      searchMemory: async () => ({ results: [] }),
      readMemory: async () => ({}),
      writeMemory: async () => { calls.push("write"); return {}; },
      patchMemory: async () => { calls.push("patch"); return {}; },
      moveMemory: async () => { calls.push("mv"); },
      deleteMemory: async () => { calls.push("rm"); },
    };
    const deps = { client, readSource: async () => "# x" };
    for (const args of [
      ["rm", "projects/plan.md", "--workspace", ""], ["rm", "projects/plan.md", "--workspace"], ["rm", "projects/plan.md", "--workspace="],
      ["write", "a.md", "--file", "a.md", "--workspace", ""], ["mv", "a.md", "b.md", "--workspace"],
    ]) {
      expect(await runMemory(deps, parseGlobalFlags(args)), args.join(" ")).toBe(ExitCode.Usage);
    }
    expect(calls).toEqual([]);
  });

  it("patch deletes only with an explicit empty --new, and write refuses empty content", async () => {
    const patches: Array<{ oldString: string; newString: string }> = [];
    const client: MemoryClient = {
      searchMemory: async () => ({ results: [] }),
      readMemory: async () => ({}),
      writeMemory: async () => ({}),
      patchMemory: async (body) => { patches.push(body); return {}; },
      moveMemory: async () => undefined,
      deleteMemory: async () => undefined,
    };
    expect(await runMemory({ client, readSource: async () => "" }, parseGlobalFlags(["patch", "a.md", "--old", "draft", "--new", ""]))).toBe(ExitCode.OK);
    expect(patches).toEqual([{ path: "a.md", oldString: "draft", newString: "" }]);
    // A bare --new (here, because its value starts with "--") must not delete the passage.
    expect(await runMemory({ client, readSource: async () => "" }, parseGlobalFlags(["patch", "a.md", "--old", "make build", "--new", "--dry-run make build"]))).toBe(ExitCode.Usage);
    expect(await runMemory({ client, readSource: async () => "" }, parseGlobalFlags(["patch", "a.md", "--old", "make build", "--new=--dry-run make build"]))).toBe(ExitCode.OK);
    expect(patches.at(-1)).toEqual({ path: "a.md", oldString: "make build", newString: "--dry-run make build" });
    expect(await runMemory({ client, readSource: async () => "  " }, parseGlobalFlags(["write", "a.md", "--file", "x.md"]))).toBe(ExitCode.Usage);
  });
});

// Agents run --help to learn a command. It must print usage, not a flag error.
describe("--help", () => {
  it("prints usage and exits 0 on every command, including an argument-taking subcommand", async () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const client: MemoryClient = {
      searchMemory: async () => ({ results: [] }), readMemory: async () => ({}), writeMemory: async () => ({}),
      patchMemory: async () => ({}), moveMemory: async () => undefined, deleteMemory: async () => undefined,
    };
    expect(await runMemory({ client, readSource: async () => "" }, parseGlobalFlags(["--help"]))).toBe(ExitCode.OK);
    expect(await runMemory({ client, readSource: async () => "" }, parseGlobalFlags(["rm", "--help"]))).toBe(ExitCode.OK);
    expect(out.mock.calls.map((c) => String(c[0])).join("")).toContain("usage: valet memory");
  });
});

