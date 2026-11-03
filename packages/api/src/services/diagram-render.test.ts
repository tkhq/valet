import { describe, expect, it, vi } from "vitest";
import { VirtualSandboxProvider, type Sandbox, type ThreadFileStore, type ToolContext } from "@valet/engine";
import { buildDiagramRenderTool, diagramFileStem, diagramRenderScript, MERMAID_CLI_PACKAGE } from "./diagram-render.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);
const SOURCE = "flowchart LR\n  web --> api --> sandbox";

function context(sandbox: Sandbox, threadFiles?: ThreadFileStore, origin?: ToolContext["origin"]): ToolContext {
  return {
    userId: "local-user", orgId: "local-org", sessionId: "session", threadId: "thread", sandbox,
    credentials: { get: async () => null, request: async () => { throw new Error("unused"); } },
    requestDecision: async () => { throw new Error("unused"); },
    signal: new AbortController().signal, threadRead: async () => [], listThreads: async () => [],
    setModel: async ({ model }) => ({ fromModel: model, toModel: model }),
    ...(threadFiles ? { threadFiles } : {}),
    ...(origin ? { origin } : {}),
  };
}

function store(): ThreadFileStore & { save: ReturnType<typeof vi.fn> } {
  const save = vi.fn(async (file: { name: string; mimeType: string; data: Uint8Array }) => ({
    id: "file-1", name: file.name, mimeType: file.mimeType, bytes: file.data.byteLength,
    url: "/api/sessions/session/threads/thread/files/file-1", webUrl: "/api/sessions/session/threads/thread/files/file-1",
  }));
  return { save, read: async () => null };
}

async function sandbox(): Promise<Sandbox> {
  return new VirtualSandboxProvider().create({ sessionId: "test", workspace: "/workspace" });
}

describe("render_diagram", () => {
  it("renders the source with the pinned mermaid-cli and the sandbox Chromium", () => {
    const script = diagramRenderScript("/tmp/d", "flow-1234abcd");
    expect(script).toContain(`npx --yes ${MERMAID_CLI_PACKAGE}`);
    expect(script).toContain("command -v valet-chromium || command -v chromium");
    expect(script).toContain('-i "$dir/in.mmd" -o "$out"');
    expect(diagramFileStem("Request flow!", SOURCE)).toMatch(/^request-flow-[0-9a-f]{8}$/);
    expect(diagramFileStem(undefined, SOURCE)).toMatch(/^diagram-[0-9a-f]{8}$/);
  });

  it("saves the PNG as a thread file the chat shows inline, and cleans up its scratch directory", async () => {
    const box = await sandbox();
    const files = store();
    const exec = vi.spyOn(box, "exec").mockImplementation(async () => {
      await box.writeBinary("/workspace/diagrams/request-flow.png", PNG);
      return { stdout: "/workspace/diagrams/request-flow.png\n", stderr: "", exitCode: 0 };
    });
    const write = vi.spyOn(box, "writeFile");
    const rm = vi.spyOn(box, "rm");
    const result = await buildDiagramRenderTool().execute({ source: SOURCE, alt: "Web calls the api, which calls the sandbox", title: "Request flow" }, context(box, files));
    expect(result.ok).toBe(true);
    expect(write).toHaveBeenCalledWith(expect.stringMatching(/^\/workspace\/diagrams\/\.render-[\w-]+\/in\.mmd$/), SOURCE);
    expect(exec).toHaveBeenCalledWith(expect.stringContaining(MERMAID_CLI_PACKAGE), expect.objectContaining({ timeout: 180_000 }));
    expect(files.save).toHaveBeenCalledWith({ name: expect.stringMatching(/^request-flow-[0-9a-f]{8}\.png$/), mimeType: "image/png", data: PNG });
    expect(JSON.parse(result.text)).toMatchObject({ id: "file-1", mimeType: "image/png", path: "/workspace/diagrams/request-flow.png", alt: "Web calls the api, which calls the sandbox", title: "Request flow" });
    expect(rm).toHaveBeenCalledWith(expect.stringMatching(/^\/workspace\/diagrams\/\.render-/), { recursive: true });
  });

  it("names the Slack upload in a Slack turn", async () => {
    const box = await sandbox();
    vi.spyOn(box, "exec").mockImplementation(async () => {
      await box.writeBinary("/workspace/diagrams/d.png", PNG);
      return { stdout: "/workspace/diagrams/d.png", stderr: "", exitCode: 0 };
    });
    const result = await buildDiagramRenderTool().execute({ source: SOURCE, alt: "Flow" }, context(box, store(), { channelType: "slack", threadKey: "slack:C1:1.2" }));
    expect(JSON.parse(result.text).slack).toContain('slack.reply_file_to_origin { file_id: "file-1"');
  });

  it.each([
    [{ exitCode: 1, stderr: "Parse error on line 2:\nExpecting 'SEMI'" }, "Fix the source and retry"],
    [{ exitCode: 64, stderr: "no Chromium in this sandbox" }, "has no Chromium"],
    [{ exitCode: 65, stderr: "no npx in this sandbox" }, "has no npx"],
    [{ exitCode: 124, stderr: "", timedOut: true }, "timed out"],
  ])("returns a corrective error when the render fails: %o", async (outcome, message) => {
    const box = await sandbox();
    const files = store();
    vi.spyOn(box, "exec").mockResolvedValue({ stdout: "", ...outcome });
    const result = await buildDiagramRenderTool().execute({ source: SOURCE, alt: "Flow" }, context(box, files));
    expect(result).toMatchObject({ ok: false, text: expect.stringContaining(message) });
    expect(files.save).not.toHaveBeenCalled();
  });

  it("refuses output that is not a PNG", async () => {
    const box = await sandbox();
    const files = store();
    vi.spyOn(box, "exec").mockImplementation(async () => {
      await box.writeFile("/workspace/diagrams/d.png", "<html>error</html>");
      return { stdout: "/workspace/diagrams/d.png", stderr: "", exitCode: 0 };
    });
    const result = await buildDiagramRenderTool().execute({ source: SOURCE, alt: "Flow" }, context(box, files));
    expect(result).toMatchObject({ ok: false, text: expect.stringContaining("did not produce a PNG") });
    expect(files.save).not.toHaveBeenCalled();
  });

  it("refuses without thread file storage and before running anything", async () => {
    const box = await sandbox();
    const exec = vi.spyOn(box, "exec");
    const result = await buildDiagramRenderTool().execute({ source: SOURCE, alt: "Flow" }, context(box));
    expect(result).toMatchObject({ ok: false, text: expect.stringContaining("mermaid code block") });
    expect(exec).not.toHaveBeenCalled();
  });
});
