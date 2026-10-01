import { afterEach, describe, expect, it, vi } from "vitest";
import type { Credential, PluginActionContext, Sandbox } from "@valet/engine";
import { docsAnalyticsPlugin } from "./actions.js";

const action = docsAnalyticsPlugin.actions[0];
if (!action) throw new Error("Docs Analytics report action is missing.");

const sandbox: Sandbox = {
  id: "sandbox-1",
  readFile: async () => "",
  readBinary: async () => new Uint8Array(),
  writeFile: async () => {},
  writeBinary: async () => {},
  readdir: async () => [],
  stat: async () => ({ isFile: false, isDirectory: false, size: 0 }),
  mkdir: async () => {},
  rm: async () => {},
  exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
};

function context(credential: Credential | null = { accessToken: "test-token" }): PluginActionContext {
  return {
    actionId: "docs_analytics.report",
    service: "docs_analytics",
    userId: "user-1",
    orgId: "org-1",
    sessionId: "session-1",
    threadId: "thread-1",
    credentials: {
      get: async () => credential,
      request: async () => {
        throw new Error("unused");
      },
    },
    sandbox,
    requestDecision: async () => {
      throw new Error("unused");
    },
    signal: new AbortController().signal,
    threadRead: async () => [],
    listThreads: async () => [],
    setModel: async () => {
      throw new Error("unused");
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("docs_analytics.report", () => {
  it("constructs an inclusive JSON report request and preserves coverage fields", async () => {
    const report = { coverage: { missing_days: ["2026-01-03"] }, pages: [] };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin + url.pathname).toBe("https://docs-analytics.vercel.app/api/report");
      expect(url.searchParams.get("from")).toBe("2026-01-01");
      expect(url.searchParams.get("to")).toBe("today");
      expect(url.searchParams.get("format")).toBe("json");
      const headers = new Headers(init?.headers);
      expect(headers.has("authorization")).toBe(true);
      expect(headers.get("authorization")).toMatch(/^Bearer .+$/);
      return Response.json(report);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(action.execute({ from: "2026-01-01", to: "today", format: "json" }, context())).resolves.toEqual({
      success: true,
      data: report,
    });
  });

  it("does not add date parameters when callers use the endpoint default", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.searchParams).toEqual(new URLSearchParams({ format: "json" }));
      return Response.json({ coverage: { missing_days: [] } });
    });
    vi.stubGlobal("fetch", fetchMock);

    await action.execute({ format: "json" }, context());
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("returns Markdown unchanged for direct delivery", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("# Docs report\n\n- 4 views")));

    await expect(action.execute({ from: "yesterday", to: "today", format: "md" }, context())).resolves.toEqual({
      success: true,
      data: "# Docs report\n\n- 4 views",
    });
  });

  it("preserves a useful 400 report error body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("from must not be after to", { status: 400 })));

    await expect(action.execute({ format: "json" }, context())).resolves.toEqual({
      success: false,
      error: "Docs Analytics rejected the report parameters: from must not be after to",
    });
  });

  it.each([
    [401, "Docs Analytics rejected the organization credential"],
    [403, "Docs Analytics denied access to this report"],
    [429, "Docs Analytics rate limited this report request"],
    [500, "Docs Analytics could not generate the report"],
    [503, "Docs Analytics could not generate the report"],
  ])("returns an accurate non-secret error for HTTP %i", async (status, message) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("service error", { status })));

    const result = await action.execute({ format: "json" }, context());
    expect(result).toMatchObject({ success: false, error: expect.stringContaining(message) });
    expect(JSON.stringify(result)).not.toContain("test-token");
  });

  it("rejects an unsafe stored token before fetch without exposing it", async () => {
    const unsafeToken = "unsafe\r\ntoken";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await action.execute({ format: "json" }, context({ accessToken: unsafeToken }));
    expect(result).toEqual({
      success: false,
      error: "Docs Analytics organization credential is malformed. Ask an organization admin to replace the credential.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(unsafeToken);
  });

  it("returns a non-secret result when fetch rejects", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("network test-token"))));

    const result = await action.execute({ format: "json" }, context());
    expect(result).toEqual({
      success: false,
      error: "Docs Analytics could not be reached. Check the service status and try again later.",
    });
    expect(JSON.stringify(result)).not.toContain("test-token");
  });

  it("returns a non-secret result when the JSON response is invalid", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not JSON")));

    await expect(action.execute({ format: "json" }, context())).resolves.toEqual({
      success: false,
      error: "Docs Analytics returned an invalid JSON report. Ask the report service owner to check the endpoint.",
    });
  });

  it("tells the caller how to configure a missing organization credential", async () => {
    await expect(action.execute({ format: "json" }, context(null))).resolves.toEqual({
      success: false,
      error: "Docs Analytics organization credential is not configured. Ask an organization admin to add the credential.",
    });
  });
});
