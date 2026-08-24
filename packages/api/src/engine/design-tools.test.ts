/**
 * design_* ToolDef tests: config gating, the patch round trip (read →
 * vdid-targeted replace → fenced write), and token lookup answers. The
 * HTTP seam is stubbed at global fetch — these verify what the tools SEND,
 * the routes' behavior is covered by design-artifacts tests.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "@valet/engine";
import { applyVdids } from "@valet/plugin-design/lib";
import { designCommentResolveTool, designEditTool, designRenderTokenTool } from "./design-tools.js";

const DOC = applyVdids(
  `<!DOCTYPE html><html><head><meta name="valet-design" content="v=1; template=document"></head><body><h1>Old</h1></body></html>`,
).html;
const H1_VDID = /<h1 data-vdid="([0-9a-f_]+)"/.exec(DOC)?.[1] ?? "";

function ctxWith(config: Record<string, unknown> | undefined): ToolContext {
  return {
    userId: "u1",
    orgId: "org1",
    sessionId: "s1",
    threadId: "t1",
    credentials: { get: () => Promise.resolve(undefined) },
    sandbox: {} as ToolContext["sandbox"],
    config,
    requestDecision: () => Promise.reject(new Error("no gates in this test")),
    signal: new AbortController().signal,
    threadRead: () => Promise.resolve([]),
    listThreads: () => Promise.resolve([]),
    setModel: () => Promise.reject(new Error("unused")),
  } as unknown as ToolContext;
}

const CFG = { apiBaseUrl: "http://api.test", internalToken: "tok" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("design tools", () => {
  it("answer [design_unavailable] without toolConfig", async () => {
    const result = await designEditTool.execute(
      { kind: "rewrite", content: DOC, summary: "x" },
      ctxWith(undefined),
    );
    expect(result.text).toContain("[design_unavailable]");
  });

  it("design_edit rewrite POSTs the document with internal auth", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", (url: URL | string, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Promise.resolve(
        new Response(JSON.stringify({ revision: "r-002", sizeBytes: 123 }), { status: 200 }),
      );
    });

    const result = await designEditTool.execute(
      { kind: "rewrite", content: DOC, summary: "restyle" },
      ctxWith(CFG),
    );
    expect(result.text).toBe("wrote revision r-002 (123 bytes)");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://api.test/api/sessions/s1/design/edit");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["x-valet-internal"]).toBe("tok");
    expect(headers["x-valet-actor"]).toBe("u1");
  });

  it("design_edit patch reads, replaces by vdid, and writes fenced on the read revision", async () => {
    const calls: Array<{ url: string; body?: unknown }> = [];
    vi.stubGlobal("fetch", (url: URL | string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/design/artifact")) {
        calls.push({ url: u });
        return Promise.resolve(
          new Response(JSON.stringify({ revision: "r-004", content: DOC }), { status: 200 }),
        );
      }
      calls.push({ url: u, body: JSON.parse(String(init?.body)) });
      return Promise.resolve(
        new Response(JSON.stringify({ revision: "r-005", sizeBytes: 999 }), { status: 200 }),
      );
    });

    const result = await designEditTool.execute(
      { kind: "patch", content: `<h1 data-vdid="${H1_VDID}">New Headline</h1>`, summary: "shorten" },
      ctxWith(CFG),
    );
    expect(result.text).toContain("wrote revision r-005");
    expect(result.text).toContain("replaced 1 element");
    const write = calls[1];
    expect(write.url).toBe("http://api.test/api/sessions/s1/design/edit");
    const body = write.body as { content: string; parentRevision: string };
    expect(body.parentRevision).toBe("r-004");
    expect(body.content).toContain("New Headline");
    expect(body.content).not.toContain(">Old<");
  });

  it("design_edit patch surfaces an unknown vdid without writing", async () => {
    const writes: string[] = [];
    vi.stubGlobal("fetch", (url: URL | string) => {
      const u = String(url);
      if (u.endsWith("/design/artifact")) {
        return Promise.resolve(
          new Response(JSON.stringify({ revision: "r-004", content: DOC }), { status: 200 }),
        );
      }
      writes.push(u);
      return Promise.resolve(new Response("{}", { status: 200 }));
    });

    const result = await designEditTool.execute(
      { kind: "patch", content: '<h1 data-vdid="ffffffffffffffff">X</h1>' },
      ctxWith(CFG),
    );
    expect(result.text).toContain("[design_edit failed]");
    expect(writes).toEqual([]);
  });

  it("design_render_token answers value, not-found, and no-design-system", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        new Response(JSON.stringify({ tokens: { "--color-primary": "#0066cc" } }), { status: 200 }),
      ),
    );
    const hit = await designRenderTokenTool.execute({ token_name: "color-primary" }, ctxWith(CFG));
    expect(hit.text).toBe("--color-primary: #0066cc");

    const miss = await designRenderTokenTool.execute({ token_name: "--nope" }, ctxWith(CFG));
    expect(miss.text).toContain("Available tokens: --color-primary");

    vi.stubGlobal("fetch", () =>
      Promise.resolve(new Response(JSON.stringify({ tokens: {} }), { status: 200 })),
    );
    const none = await designRenderTokenTool.execute({ token_name: "x" }, ctxWith(CFG));
    expect(none.text).toContain("no design system is connected");
  });

  it("design_comment_resolve POSTs the resolve route", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", (url: URL | string) => {
      urls.push(String(url));
      return Promise.resolve(new Response(JSON.stringify({ id: "dc_1", resolvedAt: 5 }), { status: 200 }));
    });
    const result = await designCommentResolveTool.execute({ comment_id: "dc_1" }, ctxWith(CFG));
    expect(result.text).toBe("resolved comment dc_1");
    expect(urls[0]).toBe("http://api.test/api/sessions/s1/design/comments/dc_1/resolve");
  });
});
