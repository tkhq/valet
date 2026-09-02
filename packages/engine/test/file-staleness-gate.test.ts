/**
 * Read-before-write staleness gate (TKAI-318). An in-memory sandbox plus a
 * real fileReads map exercise the full read → mutate → external-change
 * cycle without a session.
 *
 * Follows the stub-ctx idiom of bash-truncation.test.ts.
 */
import { describe, it, expect } from "vitest";
import { editTool, readTool, writeTool, hashFileContent } from "../src/builtin-tools/index.js";
import type {
  Credential,
  CredentialProvider,
  DecisionGateRequest,
  DecisionResolution,
  MessageQuery,
  Sandbox,
  SessionEntry,
  ToolContext,
} from "../src/types.js";

type FakeSandbox = Partial<Sandbox> & { id: string };

const stubCredentials: CredentialProvider = {
  get: async (): Promise<Credential | null> => null,
  request: async (): Promise<Credential> => {
    throw new Error("not implemented in test stub");
  },
};

function makeCtx(files: Map<string, string>): { ctx: ToolContext; files: Map<string, string> } {
  const reads = new Map<string, string>();
  const sandbox: FakeSandbox = {
    id: "sb-gate",
    readFile: async (path: string) => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    writeFile: async (path: string, content: string) => {
      files.set(path, content);
    },
  };
  const ctx: ToolContext = {
    userId: "u1",
    orgId: "o1",
    sessionId: "s1",
    threadId: "t1",
    credentials: stubCredentials,
    // FakeSandbox is intentionally partial — these tests only exercise
    // readFile/writeFile.
    sandbox: sandbox as Sandbox,
    fileReads: {
      get: (path: string) => reads.get(path),
      record: (path: string, hash: string) => reads.set(path, hash),
    },
    requestDecision: async (_gate: DecisionGateRequest): Promise<DecisionResolution> => {
      throw new Error("not implemented in test stub");
    },
    signal: new AbortController().signal,
    threadRead: async (_key: string, _opts?: MessageQuery): Promise<SessionEntry[]> => [],
    listThreads: async () => [],
    setModel: async ({ model }: { model: string }) => ({ fromModel: model, toModel: model }),
  };
  return { ctx, files };
}

describe("read-before-write staleness gate (TKAI-318)", () => {
  it("blocks editing a file that was never read, with corrective text", async () => {
    const { ctx } = makeCtx(new Map([["/a.txt", "one two"]]));
    const result = await editTool.execute({ path: "/a.txt", oldString: "one", newString: "1" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.text).toContain("has not been read");
    expect(result.text).toContain("Read it");
  });

  it("allows edit after a read, and records the new content", async () => {
    const { ctx, files } = makeCtx(new Map([["/a.txt", "one two"]]));
    await readTool.execute({ path: "/a.txt" }, ctx);
    const result = await editTool.execute({ path: "/a.txt", oldString: "one", newString: "1" }, ctx);
    expect(result.text).toBe("edited /a.txt");
    expect(files.get("/a.txt")).toBe("1 two");
    // A second edit without re-reading is fine — the write recorded the hash.
    const again = await editTool.execute({ path: "/a.txt", oldString: "two", newString: "2" }, ctx);
    expect(again.text).toBe("edited /a.txt");
  });

  it("blocks edit when the file changed after the read (external edit)", async () => {
    const { ctx, files } = makeCtx(new Map([["/a.txt", "one two"]]));
    await readTool.execute({ path: "/a.txt" }, ctx);
    files.set("/a.txt", "changed by someone else");
    const result = await editTool.execute({ path: "/a.txt", oldString: "one", newString: "1" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.text).toContain("changed since you read it");
    // Re-reading clears the gate.
    await readTool.execute({ path: "/a.txt" }, ctx);
    const retry = await editTool.execute(
      { path: "/a.txt", oldString: "someone else", newString: "me" },
      ctx,
    );
    expect(retry.text).toBe("edited /a.txt");
  });

  it("blocks overwriting an existing file that was never read", async () => {
    const { ctx } = makeCtx(new Map([["/a.txt", "precious"]]));
    const result = await writeTool.execute({ path: "/a.txt", content: "clobber" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.text).toContain("has not been read");
  });

  it("allows creating a new file without a prior read", async () => {
    const { ctx, files } = makeCtx(new Map());
    const result = await writeTool.execute({ path: "/new.txt", content: "hello" }, ctx);
    expect(result.text).toBe("wrote /new.txt");
    expect(files.get("/new.txt")).toBe("hello");
    // The write recorded the content — an immediate edit needs no read.
    const edit = await editTool.execute({ path: "/new.txt", oldString: "hello", newString: "hi" }, ctx);
    expect(edit.text).toBe("edited /new.txt");
  });

  it("is inert when the host wires no fileReads", async () => {
    const { ctx } = makeCtx(new Map([["/a.txt", "one"]]));
    const bare: ToolContext = { ...ctx, fileReads: undefined };
    const result = await editTool.execute({ path: "/a.txt", oldString: "one", newString: "1" }, bare);
    expect(result.text).toBe("edited /a.txt");
  });

  it("hashFileContent distinguishes content and length", () => {
    expect(hashFileContent("abc")).not.toBe(hashFileContent("abd"));
    expect(hashFileContent("a")).not.toBe(hashFileContent("aa"));
    expect(hashFileContent("same")).toBe(hashFileContent("same"));
  });
});
