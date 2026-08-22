/**
 * `mem_*` engine ToolDefs — drives each tool's `execute()` against a real
 * in-process HTTP server (via `bootTestApi`, the same harness the memory
 * route integration tests use) with a hand-built `ToolContext`, proving
 * the tools round-trip over the honest HTTP seam rather than a mocked
 * fetch (decision 15).
 */
import { describe, it, expect, afterEach } from "vitest";
import type {
  Credential,
  CredentialProvider,
  DecisionGateRequest,
  DecisionResolution,
  MessageQuery,
  Sandbox,
  SessionEntry,
  ToolContext,
} from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { internalToken } from "../lib/internal-auth.js";
import {
  memWriteTool,
  memPatchTool,
  memReadTool,
  memSearchTool,
  memShareTool,
  memRmTool,
  buildMemoryTools,
} from "./memory-tools.js";

const stubCredentials: CredentialProvider = {
  get: async (): Promise<Credential | null> => null,
  request: async (): Promise<Credential> => {
    throw new Error("not implemented in test stub");
  },
};

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const sandbox: Partial<Sandbox> & { id: string } = { id: "sb-1" };
  return {
    userId: "u1",
    orgId: "o1",
    sessionId: "s1",
    threadId: "t1",
    credentials: stubCredentials,
    sandbox: sandbox as Sandbox,
    requestDecision: async (_gate: DecisionGateRequest): Promise<DecisionResolution> => {
      throw new Error("not implemented in test stub");
    },
    signal: new AbortController().signal,
    threadRead: async (_key: string, _opts?: MessageQuery): Promise<SessionEntry[]> => [],
    listThreads: async () => [],
    setModel: async ({ model }: { model: string }) => ({ fromModel: model, toModel: model }),
    ...overrides,
  };
}

let api: TestApi;

afterEach(async () => {
  await api?.cleanup();
});

describe("buildMemoryTools", () => {
  it("returns exactly the six mem_* tools", () => {
    const names = buildMemoryTools().map((t) => t.name);
    expect(names).toEqual(["mem_write", "mem_patch", "mem_read", "mem_search", "mem_share", "mem_rm"]);
  });
});

describe("mem_* tools: apiBaseUrl/internalToken not configured", () => {
  it("mem_write returns [memory_unavailable] without throwing", async () => {
    const ctx = makeCtx();
    const result = await memWriteTool.execute({ path: "notes/a.md", content: "hi" }, ctx);
    expect(result.text).toBe("[memory_unavailable] memory endpoint not configured");
  });

  it("mem_read returns [memory_unavailable] when internalToken is missing", async () => {
    const ctx = makeCtx({ config: { apiBaseUrl: "http://localhost:1" } });
    const result = await memReadTool.execute({ path: "notes/a.md" }, ctx);
    expect(result.text).toBe("[memory_unavailable] memory endpoint not configured");
  });
});

describe("mem_* tools: network-level failure", () => {
  it("mem_read against an unreachable port returns [memory_error] instead of throwing", async () => {
    const ctx = makeCtx({
      config: { apiBaseUrl: "http://127.0.0.1:1", internalToken: "t" },
      owner: { type: "user", id: "local-user" },
    });
    const result = await memReadTool.execute({ path: "notes/a.md" }, ctx);
    expect(result.text).toMatch(/^\[memory_error\]/);
  });
});

describe("mem_* tools: real HTTP round trip", () => {
  it("mem_write creates a file, then mem_read reads it back", async () => {
    api = await bootTestApi();
    const ctx = makeCtx({
      userId: "local-user",
      config: { apiBaseUrl: api.baseUrl, internalToken: internalToken() },
      owner: { type: "user", id: "local-user" },
    });

    const writeResult = await memWriteTool.execute(
      { path: "notes/hello.md", content: "# Hello\n\nWorld.\n" },
      ctx,
    );
    expect(writeResult.text).toBe("wrote notes/hello.md (v1)");

    const readResult = await memReadTool.execute({ path: "notes/hello.md" }, ctx);
    expect(readResult.text).toContain("World.");
  });

  it("mem_write relays ⚠ warnings from the service", async () => {
    api = await bootTestApi();
    const ctx = makeCtx({
      userId: "local-user",
      config: { apiBaseUrl: api.baseUrl, internalToken: internalToken() },
      owner: { type: "user", id: "local-user" },
    });

    const result = await memWriteTool.execute(
      { path: "notes/echo.md", content: "---\nvalet:\n  bogus_key: x\n---\nBody.\n" },
      ctx,
    );
    expect(result.text).toContain("⚠");
    expect(result.text).toContain("bogus_key");
  });

  it("mem_patch replaces text in an existing file", async () => {
    api = await bootTestApi();
    const ctx = makeCtx({
      userId: "local-user",
      config: { apiBaseUrl: api.baseUrl, internalToken: internalToken() },
      owner: { type: "user", id: "local-user" },
    });

    await memWriteTool.execute({ path: "notes/patchable.md", content: "# T\n\nAlpha.\n" }, ctx);
    const patchResult = await memPatchTool.execute(
      { path: "notes/patchable.md", oldString: "Alpha", newString: "Beta" },
      ctx,
    );
    expect(patchResult.text).toBe("patched notes/patchable.md (v2)");

    const readResult = await memReadTool.execute({ path: "notes/patchable.md" }, ctx);
    expect(readResult.text).toContain("Beta.");
    expect(readResult.text).not.toContain("Alpha.");
  });

  it("mem_patch with oldString '' creates a new file (journal-append idiom)", async () => {
    api = await bootTestApi();
    const ctx = makeCtx({
      userId: "local-user",
      config: { apiBaseUrl: api.baseUrl, internalToken: internalToken() },
      owner: { type: "user", id: "local-user" },
    });

    const result = await memPatchTool.execute({ path: "journal/2026-07-13.md", oldString: "", newString: "# Entry\n" }, ctx);
    expect(result.text).toBe("patched journal/2026-07-13.md (v1)");
  });

  it("mem_read on a directory returns the virtual index", async () => {
    api = await bootTestApi();
    const ctx = makeCtx({
      userId: "local-user",
      config: { apiBaseUrl: api.baseUrl, internalToken: internalToken() },
      owner: { type: "user", id: "local-user" },
    });
    await memWriteTool.execute({ path: "notes/one.md", content: "# One\n" }, ctx);

    const result = await memReadTool.execute({ path: "notes/" }, ctx);
    expect(result.text).toContain("one.md");
  });

  it("mem_read on a missing file surfaces a [memory_error]", async () => {
    api = await bootTestApi();
    const ctx = makeCtx({
      userId: "local-user",
      config: { apiBaseUrl: api.baseUrl, internalToken: internalToken() },
      owner: { type: "user", id: "local-user" },
    });

    const result = await memReadTool.execute({ path: "notes/does-not-exist.md" }, ctx);
    expect(result.text).toMatch(/^\[memory_error\]/);
  });

  it("mem_search finds a written file by content", async () => {
    api = await bootTestApi();
    const ctx = makeCtx({
      userId: "local-user",
      config: { apiBaseUrl: api.baseUrl, internalToken: internalToken() },
      owner: { type: "user", id: "local-user" },
    });
    await memWriteTool.execute({ path: "notes/searchable.md", content: "# Searchable\n\nUnique needle text.\n" }, ctx);

    const result = await memSearchTool.execute({ query: "needle" }, ctx);
    expect(result.text).toContain("notes/searchable.md");
  });

  it("mem_search with no matches reports emptiness instead of an empty string", async () => {
    api = await bootTestApi();
    const ctx = makeCtx({
      userId: "local-user",
      config: { apiBaseUrl: api.baseUrl, internalToken: internalToken() },
      owner: { type: "user", id: "local-user" },
    });

    const result = await memSearchTool.execute({ query: "nonexistentxyz" }, ctx);
    expect(result.text).toContain("no memory results");
  });

  it("mem_rm deletes a file; a second mem_read then [memory_error]s", async () => {
    api = await bootTestApi();
    const ctx = makeCtx({
      userId: "local-user",
      config: { apiBaseUrl: api.baseUrl, internalToken: internalToken() },
      owner: { type: "user", id: "local-user" },
    });
    await memWriteTool.execute({ path: "notes/doomed.md", content: "# Doomed\n" }, ctx);

    const rmResult = await memRmTool.execute({ path: "notes/doomed.md" }, ctx);
    expect(rmResult.text).toBe("removed notes/doomed.md");

    const readResult = await memReadTool.execute({ path: "notes/doomed.md" }, ctx);
    expect(readResult.text).toMatch(/^\[memory_error\]/);
  });

  it("mem_write against a nonexistent update-only path surfaces the service's [memory_error]", async () => {
    api = await bootTestApi();
    const ctx = makeCtx({
      userId: "local-user",
      config: { apiBaseUrl: api.baseUrl, internalToken: internalToken() },
      owner: { type: "user", id: "local-user" },
    });

    const result = await memWriteTool.execute({ path: "notes/never-created.md" }, ctx);
    expect(result.text).toMatch(/^\[memory_error\]/);
    expect(result.text).toContain("does not exist");
  });

  it("writes carry an explicit owner tuple distinct from ctx.userId (internal dual auth)", async () => {
    api = await bootTestApi();
    const ctx = makeCtx({
      userId: "local-user",
      config: { apiBaseUrl: api.baseUrl, internalToken: internalToken() },
      owner: { type: "team", id: "eng" },
    });

    const writeResult = await memWriteTool.execute({ path: "notes/team.md", content: "# Team note\n" }, ctx);
    expect(writeResult.text).toBe("wrote notes/team.md (v1)");

    // Read back with a *user* owner who is on no teams — must not see it,
    // proving mem_write actually wrote to the team scope, not the actor's.
    const otherUserCtx = makeCtx({
      userId: "local-user",
      config: { apiBaseUrl: api.baseUrl, internalToken: internalToken() },
      owner: { type: "user", id: "someone-else" },
    });
    const readResult = await memReadTool.execute({ path: "notes/team.md" }, otherUserCtx);
    expect(readResult.text).toMatch(/^\[memory_error\]/);
  });

  it("mem_share round-trips: share returns a URL + audience line, revoke confirms", async () => {
    api = await bootTestApi();
    const ctx = makeCtx({
      userId: "local-user",
      config: { apiBaseUrl: api.baseUrl, internalToken: internalToken() },
      owner: { type: "user", id: "local-user" },
    });

    await memWriteTool.execute({ path: "artifacts/report.md", content: "# Report\n\nBody.\n" }, ctx);

    const shared = await memShareTool.execute({ path: "artifacts/report.md" }, ctx);
    expect(shared.text).toContain("shared artifacts/report.md → ");
    expect(shared.text).toContain("/a/");
    // The audience line is what the agent relays — it must state the login
    // requirement, not imply a public link.
    expect(shared.text).toContain("logged-in members");

    const revoked = await memShareTool.execute({ path: "artifacts/report.md", revoke: true }, ctx);
    expect(revoked.text).toBe("revoked share for artifacts/report.md");

    const reRevoke = await memShareTool.execute({ path: "artifacts/report.md", revoke: true }, ctx);
    expect(reRevoke.text).toMatch(/^\[memory_error\]/);
  });
});
