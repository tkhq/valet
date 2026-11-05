import { afterEach, describe, expect, it, vi } from "vitest";
import type { Credential, CredentialProvider, DecisionGateRequest, DecisionResolution, MessageQuery, Sandbox, SessionEntry, ToolContext } from "@valet/engine";
import { Value } from "typebox/value";
import { googleWorkspacePlugin } from "../actions.js";
import { classifyAction, extractFileId, extractCreatedFileId } from "../labels-guard.js";
type FakeSandbox = Partial<Sandbox> & { id: string };

function makeCredentials(token: string | null): CredentialProvider {
  return {
    get: async (): Promise<Credential | null> => (token === null ? null : { accessToken: token }),
    request: async (): Promise<Credential> => {
      throw new Error('not implemented in test stub');
    },
  };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const sandbox: FakeSandbox = { id: 'sb-1' };
  return {
    userId: 'u1',
    orgId: 'o1',
    sessionId: 's1',
    threadId: 't1',
    credentials: makeCredentials('test-token'),
    sandbox: sandbox as Sandbox,
    requestDecision: async (_gate: DecisionGateRequest): Promise<DecisionResolution> => {
      throw new Error('not implemented in test stub');
    },
    signal: new AbortController().signal,
    threadRead: async (_key: string, _opts?: MessageQuery): Promise<SessionEntry[]> => [],
    listThreads: async () => [],
    setModel: async ({ model }: { model: string }) => ({ fromModel: model, toModel: model }),
    ...overrides,
  };
}

function pluginCtx(overrides: Partial<ToolContext> = {}) {
  return { ...makeCtx(overrides), actionId: '', service: 'google_workspace' };
}


function action(id: string) {
  const found = googleWorkspacePlugin.actions?.find(a => a.id === id);
  if (!found) throw new Error(`Missing action ${id}`);
  return found;
}
afterEach(() => vi.unstubAllGlobals());
describe("native Slides actions", () => {
  it("reads a bounded deck summary through Google credentials", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ presentationId: "deck", revisionId: "rev", slides: [{ objectId: "slide1" }] }));
    vi.stubGlobal("fetch", fetcher);
    const result = await action("slides.get_presentation").execute({ presentationId: "deck" }, pluginCtx());
    expect(result.success).toBe(true);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toContain("https://slides.googleapis.com/v1/presentations/deck?fields=");
    expect(decodeURIComponent(url)).not.toContain("textElements");
    expect(init.headers.Authorization).toBe("Bearer test-token");
    expect(init.signal).toBeDefined();
  });
  it("sends atomic edits with the revision the caller read", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ presentationId: "deck", replies: [{}] }));
    vi.stubGlobal("fetch", fetcher);
    const requests = [{ replaceAllText: { containsText: { text: "Old", matchCase: true }, replaceText: "New" } }];
    const result = await action("slides.batch_update").execute({ presentationId: "deck", requiredRevisionId: "rev", requests }, pluginCtx());
    expect(result.success).toBe(true);
    expect(fetcher.mock.calls[0][0]).toBe("https://slides.googleapis.com/v1/presentations/deck:batchUpdate");
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ requests, writeControl: { requiredRevisionId: "rev" } });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("does not send writes without credentials", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const result = await action("slides.create_presentation").execute({ title: "Demo" }, pluginCtx({ credentials: makeCredentials(null) }));
    expect(result).toMatchObject({ success: false, error: expect.stringContaining("Connect Google Workspace") });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("distinguishes a disabled API from file permissions", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: { message: "API disabled", details: [{ reason: "SERVICE_DISABLED", metadata: { service: "slides.googleapis.com" } }] } }, { status: 403 })));
    const result = await action("slides.get_presentation").execute({ presentationId: "deck" }, pluginCtx());
    expect(result).toMatchObject({ success: false, error: expect.stringContaining("project administrator") });
  });
  it("does not retry a revision conflict or failed write", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ error: { message: "revision mismatch" } }, { status: 400 }));
    vi.stubGlobal("fetch", fetcher);
    const result = await action("slides.batch_update").execute({ presentationId: "deck", requiredRevisionId: "old", requests: [{ deleteObject: { objectId: "shape" } }] }, pluginCtx());
    expect(result.success).toBe(false);
    expect(result.error).toContain("Read the presentation again");
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("requires revision protection and bounds batch sizes at the tool boundary", () => {
    const schema = action("slides.batch_update").parameters;
    expect(Value.Check(schema, { presentationId: "deck", requests: [{}] })).toBe(false);
    expect(Value.Check(schema, { presentationId: "deck", requiredRevisionId: "rev", requests: Array.from({ length: 101 }, () => ({})) })).toBe(false);
    expect(action("slides.batch_update").riskLevel).toBe("high");
  });
  it.each([
    ["slides.get_page", "/pages/slide1"],
    ["slides.get_thumbnail", "/pages/slide1/thumbnail"],
  ])("routes %s to the selected slide", async (name, suffix) => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ objectId: "slide1" }));
    vi.stubGlobal("fetch", fetcher);
    expect((await action(name).execute({ presentationId: "deck", pageObjectId: "slide1" }, pluginCtx())).success).toBe(true);
    expect(fetcher.mock.calls[0][0]).toBe(`https://slides.googleapis.com/v1/presentations/deck${suffix}`);
  });
  it("does not confuse access denial with disabled API configuration", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: { message: "Permission denied" } }, { status: 403 })));
    const result = await action("slides.get_presentation").execute({ presentationId: "deck" }, pluginCtx());
    expect(result.error).toContain("connected Google account");
    expect(result.error).not.toContain("enable the Slides API");
  });
  it("classifies reads, writes, and created presentations for the shared guard", () => {
    expect(classifyAction("slides.get_presentation")).toBe("read_get");
    expect(classifyAction("slides.get_page")).toBe("read_get");
    expect(classifyAction("slides.batch_update")).toBe("write_modify");
    expect(classifyAction("slides.create_presentation")).toBe("create");
    expect(extractFileId("slides.batch_update", { presentationId: "deck" })).toBe("deck");
    expect(extractCreatedFileId("slides.create_presentation", { success: true, data: { presentationId: "deck" } })).toBe("deck");
  });
});
