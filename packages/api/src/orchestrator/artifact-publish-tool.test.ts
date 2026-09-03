/**
 * `artifact_publish` publishing from a sandbox file path (`path`) as an
 * alternative to inline `content`. Unlike `memory-tools.test.ts`'s real-HTTP
 * round trips, this suite stubs `globalThis.fetch` directly so it can assert
 * on the exact request body the tool sends — the wire shape to
 * `POST /api/artifacts/share` is unchanged (`key` + `content` + metadata).
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import type {
  Credential,
  CredentialProvider,
  DecisionGateRequest,
  DecisionResolution,
  ExecOpts,
  ExecResult,
  MessageQuery,
  Sandbox,
  SessionEntry,
  ToolContext,
} from "@valet/engine";
import { buildMemoryTools } from "./memory-tools.js";

const publishTool = buildMemoryTools().find((t) => t.name === "artifact_publish")!;

const unused = async (): Promise<never> => {
  throw new Error("unused");
};

function stubSandbox(files: Record<string, string>): Sandbox {
  return {
    id: "sb-test",
    readFile: async (p: string) => {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`);
      return files[p];
    },
    stat: async (p: string) => ({
      isFile: p in files,
      isDirectory: false,
      size: p in files ? Buffer.byteLength(files[p]) : 0,
    }),
    readBinary: unused,
    writeFile: unused,
    writeBinary: unused,
    readdir: unused,
    mkdir: unused,
    rm: unused,
    exec: async (_command: string, _opts?: ExecOpts): Promise<ExecResult> => {
      throw new Error("unused");
    },
  };
}

const stubCredentials: CredentialProvider = {
  get: async (): Promise<Credential | null> => null,
  request: async (): Promise<Credential> => {
    throw new Error("not implemented in test stub");
  },
};

function makeCtx(sandbox: Sandbox, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    userId: "u1",
    orgId: "o1",
    sessionId: "s1",
    threadId: "t1",
    credentials: stubCredentials,
    sandbox,
    requestDecision: async (_gate: DecisionGateRequest): Promise<DecisionResolution> => {
      throw new Error("not implemented in test stub");
    },
    signal: new AbortController().signal,
    threadRead: async (_key: string, _opts?: MessageQuery): Promise<SessionEntry[]> => [],
    listThreads: async () => [],
    setModel: async ({ model }: { model: string }) => ({ fromModel: model, toModel: model }),
    config: { apiBaseUrl: "http://127.0.0.1:9999", internalToken: "t" },
    owner: { type: "user", id: "u1" },
    ...overrides,
  };
}

type FetchMock = ReturnType<typeof vi.fn<(url: string | URL, init?: RequestInit) => Promise<Response>>>;

function stubFetchOk(body: unknown): { fetchMock: FetchMock } {
  const fetchMock: FetchMock = vi.fn(async (_url, _init) => new Response(JSON.stringify(body), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

async function capturedBody(fetchMock: FetchMock): Promise<Record<string, unknown>> {
  const [, init] = fetchMock.mock.calls[0];
  if (!init || typeof init.body !== "string") throw new Error("expected a JSON string body");
  const parsed: unknown = JSON.parse(init.body);
  if (!isRecord(parsed)) throw new Error("expected a JSON object body");
  return parsed;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("artifact_publish: path publish", () => {
  it("reads the sandbox file and publishes it with a key derived from the path", async () => {
    const { fetchMock } = stubFetchOk({ url: "https://x/a/t1", visibility: "org", version: 1 });
    const sandbox = stubSandbox({ "/workspace/report.html": "<title>Deploys</title>" });
    const ctx = makeCtx(sandbox);

    const result = await publishTool.execute({ path: "/workspace/report.html" }, ctx);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = await capturedBody(fetchMock);
    expect(body.key).toBe("workspace/report.html");
    expect(body.content).toBe("<title>Deploys</title>");
    expect(body.format).toBe("html");
    expect(result.text).toContain("published");
  });
});

describe("artifact_publish: exactly-one-of content/path", () => {
  it("rejects when neither content nor path is given", async () => {
    const sandbox = stubSandbox({});
    const ctx = makeCtx(sandbox);

    const result = await publishTool.execute({}, ctx);
    expect(result.text).toContain("exactly one of");
  });

  it("rejects when both content and path are given", async () => {
    const sandbox = stubSandbox({ "/x.md": "hi" });
    const ctx = makeCtx(sandbox);

    const result = await publishTool.execute({ path: "/x.md", content: "hi" }, ctx);
    expect(result.text).toContain("exactly one of");
  });
});

describe("artifact_publish: stat throws (dead/superseded sandbox)", () => {
  it("names the corrective action instead of the not-a-file message, and never calls fetch", async () => {
    const { fetchMock } = stubFetchOk({});
    const sandbox = stubSandbox({ "/workspace/report.html": "<title>Deploys</title>" });
    vi.spyOn(sandbox, "stat").mockRejectedValue(new Error("sandbox sb-test is gone"));
    const ctx = makeCtx(sandbox);

    const result = await publishTool.execute({ path: "/workspace/report.html" }, ctx);

    expect(result.text).toContain("[artifact_error]");
    expect(result.text).toContain("could not stat");
    expect(result.text).toContain("/workspace/report.html");
    expect(result.text).toContain("retry");
    expect(result.text).not.toContain("is not a file in the sandbox");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("artifact_publish: missing file", () => {
  it("names the sandbox path when it is not a file", async () => {
    const sandbox = stubSandbox({});
    const ctx = makeCtx(sandbox);

    const result = await publishTool.execute({ path: "/workspace/nope.html" }, ctx);
    expect(result.text).toContain("is not a file in the sandbox");
  });
});

describe("artifact_publish: size cap", () => {
  it("rejects an oversized file without reading it", async () => {
    const sandbox = stubSandbox({});
    const readFileSpy = vi.spyOn(sandbox, "readFile");
    vi.spyOn(sandbox, "stat").mockResolvedValue({
      isFile: true,
      isDirectory: false,
      size: 3 * 1024 * 1024,
    });
    const ctx = makeCtx(sandbox);

    const result = await publishTool.execute({ path: "/workspace/huge.html" }, ctx);

    expect(result.text).toContain("MiB");
    expect(readFileSpy).not.toHaveBeenCalled();
  });
});

describe("artifact_publish: readFile throws after stat succeeds (TOCTOU)", () => {
  it("names the corrective action instead of throwing, and never calls fetch", async () => {
    const { fetchMock } = stubFetchOk({});
    const sandbox = stubSandbox({ "/workspace/racy.html": "<title>Racy</title>" });
    vi.spyOn(sandbox, "readFile").mockRejectedValue(new Error("ENOENT: racy.html"));
    const ctx = makeCtx(sandbox);

    const result = await publishTool.execute({ path: "/workspace/racy.html" }, ctx);

    expect(result.text).toContain("[artifact_error]");
    expect(result.text).toContain("could not read");
    expect(result.text).toContain("/workspace/racy.html");
    expect(result.text).toContain("retry");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("artifact_publish: markdown inference", () => {
  it("infers markdown format from a non-html extension", async () => {
    const { fetchMock } = stubFetchOk({ url: "https://x/a/t2", visibility: "org", version: 1 });
    const sandbox = stubSandbox({ "/notes/summary.md": "# Summary\n" });
    const ctx = makeCtx(sandbox);

    await publishTool.execute({ path: "/notes/summary.md" }, ctx);

    const body = await capturedBody(fetchMock);
    expect(body.format).toBe("markdown");
    expect(body.key).toBe("notes/summary.md");
  });
});

describe("artifact_publish: revoke derives key from path", () => {
  it("revokes using a key normalized from `path` when `key` is not given", async () => {
    const { fetchMock } = stubFetchOk({});
    const sandbox = stubSandbox({});
    const ctx = makeCtx(sandbox);

    const result = await publishTool.execute({ path: "/workspace/report.html", revoke: true }, ctx);

    const body = await capturedBody(fetchMock);
    expect(body.key).toBe("workspace/report.html");
    expect(body.revoke).toBe(true);
    expect(result.text).toBe("revoked page workspace/report.html");
  });
});

describe("artifact_publish: empty file", () => {
  it("rejects an empty sandbox file with the corrective text, and never calls fetch", async () => {
    const { fetchMock } = stubFetchOk({});
    const sandbox = stubSandbox({ "/workspace/blank.html": "" });
    const ctx = makeCtx(sandbox);

    const result = await publishTool.execute({ path: "/workspace/blank.html" }, ctx);

    expect(result.text).toBe(
      "[artifact_error] /workspace/blank.html is empty. Write the page content to the file, then publish again.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("artifact_publish: canonical key normalization", () => {
  it("collapses a doubled slash in the derived key, and echoes the resolved key", async () => {
    const { fetchMock } = stubFetchOk({ url: "https://x/a/t3", visibility: "org", version: 1 });
    const sandbox = stubSandbox({ "/workspace//report.html": "<title>Deploys</title>" });
    const ctx = makeCtx(sandbox);

    const result = await publishTool.execute({ path: "/workspace//report.html" }, ctx);

    const body = await capturedBody(fetchMock);
    expect(body.key).toBe("workspace/report.html");
    expect(result.text).toContain("published workspace/report.html");
  });

  it("returns the corrective error, without calling fetch, for a path the normalizer rejects", async () => {
    const { fetchMock } = stubFetchOk({});
    const sandbox = stubSandbox({ "/workspace/bad:name.html": "<title>Deploys</title>" });
    const ctx = makeCtx(sandbox);

    const result = await publishTool.execute({ path: "/workspace/bad:name.html" }, ctx);

    expect(result.text).toContain("[artifact_error] cannot derive a publish key from");
    expect(result.text).toContain("Pass an explicit key");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
