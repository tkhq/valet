import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, and, sql } from "drizzle-orm";
import { agentSessions, teams, teamMembers } from "../schema/index.js";
import { DEFAULT_MAX_UPLOAD_BYTES } from "@valet/shared";
import { VirtualSandboxProvider, type Sandbox, type ToolContext } from "@valet/engine";
import { buildFileAttachTool, generatedFileKey, readGeneratedFile } from "./generated-files.js";
import { loadSessionMeta } from "../engine/session-meta.js";
import { FsBlobStore } from "../providers/blob-fs.js";
import { bootTestApi, type TestApi } from "../integration/_setup.js";

function context(sandbox: Sandbox, sessionId = "session", threadId = "thread"): ToolContext {
  return {
    userId: "local-user", orgId: "local-org", sessionId, threadId, sandbox,
    credentials: { get: async () => null, request: async () => { throw new Error("unused"); } },
    requestDecision: async () => { throw new Error("unused"); },
    signal: new AbortController().signal, threadRead: async () => [], listThreads: async () => [],
    setModel: async ({ model }) => ({ fromModel: model, toModel: model }),
  };
}

let api: TestApi | undefined;
let directory: string | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; if (directory) await rm(directory, { recursive: true, force: true }); directory = undefined; });

function parseOutput(text: string): { name: string; bytes: number; mimeType: string; url: string } {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || !("name" in value) || typeof value.name !== "string" || !("bytes" in value) || typeof value.bytes !== "number" || !("mimeType" in value) || typeof value.mimeType !== "string" || !("url" in value) || typeof value.url !== "string") throw new Error("invalid attachment result");
  return { name: value.name, bytes: value.bytes, mimeType: value.mimeType, url: value.url };
}

const bytes = new Uint8Array([0x50, 0x4b, 3, 4, 0, 255, 128, 0, 13, 10]);

async function testSandbox() {
  const provider = new VirtualSandboxProvider();
  return provider.create({ sessionId: "test", workspace: "/workspace" });
}

describe("file_attach", () => {
  it("retains exact binary bytes and metadata across store replacement and sandbox deletion", async () => {
    directory = await mkdtemp(join(tmpdir(), "generated-files-"));
    const blobs = new FsBlobStore(directory);
    const sandbox = await testSandbox();
    const path = '/workspace/revised résumé.docx';
    await sandbox.writeBinary(path, bytes);
    const result = await buildFileAttachTool(blobs).execute({ path }, context(sandbox));
    expect(result.ok).toBe(true);
    const output = parseOutput(result.text);
    expect(output).toMatchObject({ name: "revised résumé.docx", bytes: bytes.length, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
    expect(output.url).toMatch(/^\/api\/sessions\/session\/threads\/thread\/files\/[\da-f-]+$/);
    await sandbox.rm(path);
    const reopened = new FsBlobStore(directory);
    const id = output.url.split("/").at(-1);
    if (!id) throw new Error("missing file id");
    const file = await readGeneratedFile(reopened, generatedFileKey("local-org", "session", "thread", id));
    expect(file?.name).toBe("revised résumé.docx");
    expect(new Uint8Array(await new Response(file?.data).arrayBuffer())).toEqual(bytes);
    expect(await readGeneratedFile(reopened, generatedFileKey("other-org", "session", "thread", id))).toBeNull();
  });

  it("rejects oversized files before reading and checks the bytes after a file changes", async () => {
    directory = await mkdtemp(join(tmpdir(), "generated-files-"));
    const tool = buildFileAttachTool(new FsBlobStore(directory));
    const sandbox = await testSandbox();
    const read = vi.spyOn(sandbox, "readBinary");
    vi.spyOn(sandbox, "stat").mockResolvedValue({ isFile: true, isDirectory: false, size: DEFAULT_MAX_UPLOAD_BYTES + 1 });
    expect((await tool.execute({ path: "/workspace/a.docx" }, context(sandbox))).ok).toBe(false);
    expect(read).not.toHaveBeenCalled();
    vi.spyOn(sandbox, "stat").mockResolvedValue({ isFile: true, isDirectory: false, size: 1 });
    read.mockResolvedValue(new Uint8Array(DEFAULT_MAX_UPLOAD_BYTES + 1));
    expect((await tool.execute({ path: "/workspace/a.docx" }, context(sandbox))).ok).toBe(false);
    expect((await tool.execute({ path: "/workspace/a\r\n.docx" }, context(sandbox))).ok).toBe(false);
  });

  it("downloads the durable binary with attachment headers and rejects another user or thread", async () => {
    api = await bootTestApi();
    const created = await fetch(`${api.baseUrl}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspace: "/tmp" }) });
    expect(created.status).toBe(201);
    const response: unknown = await created.json();
    if (typeof response !== "object" || response === null || !("id" in response) || typeof response.id !== "string") throw new Error("missing session id");
    const { id } = response;
    const [row] = await api.providers.db.select().from(agentSessions).where(eq(agentSessions.id, id));
    const session = await api.providers.engineHost.sessionFor(id, await loadSessionMeta(api.providers.db, row));
    const thread = await session.ensureDefaultThread();
    const { sandbox } = await session.attachment.ensureReady({ timeoutMs: 30_000 });
    await sandbox.writeBinary("/workspace/revised.docx", bytes);
    const result = await buildFileAttachTool(api.providers.blobs).execute({ path: "/workspace/revised.docx" }, context(sandbox, id, thread.id));
    expect(result.ok).toBe(true);
    const output = parseOutput(result.text);
    const privateThread = await session.createThread("app-assistant:test-member");
    const privateResult = await buildFileAttachTool(api.providers.blobs).execute({ path: "/workspace/revised.docx" }, context(sandbox, id, privateThread.id));
    const privateOutput = parseOutput(privateResult.text);
    await session.attachment.destroy();
    const downloaded = await fetch(`${api.baseUrl}${output.url}`);
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get("content-type")).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(downloaded.headers.get("content-disposition")).toContain('attachment; filename="revised.docx"');
    expect(downloaded.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(bytes);
    expect((await fetch(`${api.baseUrl}${output.url}`, { headers: { "x-valet-test-user-id": "test-member" } })).status).toBe(404);
    const other = await session.createThread("other");
    expect((await fetch(`${api.baseUrl}${output.url.replace(thread.id, other.id)}`)).status).toBe(404);
    const { db } = api.providers;
    await db.insert(teams).values({ id: "download-team", orgId: "local-org", name: "Documents", createdAt: Date.now() });
    await db.insert(teamMembers).values([
      { teamId: "download-team", userId: "local-user", role: "admin" },
      { teamId: "download-team", userId: "test-member", role: "member" },
    ]);
    await db.update(agentSessions).set({ ownerType: "team", ownerId: "download-team" }).where(eq(agentSessions.id, id));
    await db.execute(sql`UPDATE engine_sessions SET owner_type = 'team', owner_id = 'download-team' WHERE id = ${id}`);
    expect((await fetch(`${api.baseUrl}${output.url}`)).status).toBe(200);
    expect((await fetch(`${api.baseUrl}${privateOutput.url}`)).status).toBe(404);
    await db.delete(teamMembers).where(and(eq(teamMembers.teamId, "download-team"), eq(teamMembers.userId, "local-user")));
    expect((await fetch(`${api.baseUrl}${output.url}`)).status).toBe(404);

  });
});
