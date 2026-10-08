import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, and, sql } from "drizzle-orm";
import { agentSessions, orgs, generatedFiles, workflowDefinitions, workflowRuns, teams, teamMembers } from "../schema/index.js";
import { DEFAULT_MAX_UPLOAD_BYTES } from "@valet/shared";
import { VirtualSandboxProvider, type Principal, type Sandbox, type ToolContext } from "@valet/engine";
import { buildFileAttachTool, generatedFileKey, generatedFileOrigin, readGeneratedFile } from "./generated-files.js";
import { loadSessionMeta } from "../engine/session-meta.js";
import { FsBlobStore } from "../providers/blob-fs.js";
import { PGlite } from "@electric-sql/pglite";
import { pgDbFromPglite } from "@valet/store-postgres";
import { applyAppMigrations, buildAppDb } from "../lib/drizzle.js";
import { ensureAssistantExecution } from "../assistants/service.js";
import { linkIdentity } from "../channels/identity-links.js";
import { resetThreadAccessCache } from "./thread-access.js";
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
afterEach(async () => { vi.restoreAllMocks(); resetThreadAccessCache(); await api?.cleanup(); api = undefined; if (directory) await rm(directory, { recursive: true, force: true }); directory = undefined; });

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
  beforeEach(async () => { api = await bootTestApi(); });
  it("uses only the configured public origin for channel links", async () => {
    directory = await mkdtemp(join(tmpdir(), "generated-files-"));
    const sandbox = await testSandbox();
    await sandbox.writeBinary("/workspace/report.docx", bytes);
    const ctx = { ...context(sandbox), channelType: "slack", config: { apiBaseUrl: "https://untrusted.example", publicUrl: "https://untrusted.example" } };
    const result = await buildFileAttachTool(api!.providers.db, new FsBlobStore(directory), "https://valet.example/app?ignored=true").execute({ path: "/workspace/report.docx" }, ctx);
    expect(parseOutput(result.text).url).toMatch(/^https:\/\/valet\.example\/api\/sessions\//);
    const fallback = await buildFileAttachTool(api!.providers.db, new FsBlobStore(directory)).execute({ path: "/workspace/report.docx" }, ctx);
    expect(parseOutput(fallback.text).url).toMatch(/^\/api\/sessions\//);
    expect(fallback.text).toContain("configure VALET_PUBLIC_URL");
  });

  it.each(["javascript:alert(1)", "//other.example", "https://user:secret@other.example", "invalid"])("rejects unsafe configured origins: %s", value => {
    expect(generatedFileOrigin(value)).toBeUndefined();
  });

  it("retains exact binary bytes and metadata across store replacement and sandbox deletion", async () => {
    directory = await mkdtemp(join(tmpdir(), "generated-files-"));
    const blobs = new FsBlobStore(directory);
    const sandbox = await testSandbox();
    const path = '/workspace/revised résumé.docx';
    await sandbox.writeBinary(path, bytes);
    const result = await buildFileAttachTool(api!.providers.db, blobs, "https://valet.example").execute({ path }, context(sandbox));
    expect(result.ok).toBe(true);
    const output = parseOutput(result.text);
    expect(output).toMatchObject({ name: "revised résumé.docx", bytes: bytes.length, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
    expect(output.url).toMatch(/^https:\/\/valet\.example\/api\/sessions\/session\/threads\/thread\/files\/[\da-f-]+$/);
    await sandbox.rm(path);
    const reopened = new FsBlobStore(directory);
    const id = output.url.split("/").at(-1);
    if (!id) throw new Error("missing file id");
    const file = await readGeneratedFile(api!.providers.db, reopened, { orgId: "local-org", sessionId: "session", threadId: "thread" }, id);
    expect(file?.name).toBe("revised résumé.docx");
    expect(new Uint8Array(await new Response(file?.data).arrayBuffer())).toEqual(bytes);
    expect(await readGeneratedFile(api!.providers.db, reopened, { orgId: "other-org", sessionId: "session", threadId: "thread" }, id)).toBeNull();
  });

  it("rejects oversized files before reading and checks the bytes after a file changes", async () => {
    directory = await mkdtemp(join(tmpdir(), "generated-files-"));
    const tool = buildFileAttachTool(api!.providers.db, new FsBlobStore(directory));
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
    if (!api) throw new Error("missing API fixture");
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
    const result = await buildFileAttachTool(api!.providers.db, api.providers.blobs, api.baseUrl).execute({ path: "/workspace/revised.docx" }, context(sandbox, id, thread.id));
    expect(result.ok).toBe(true);
    const output = parseOutput(result.text);
    const privateThread = await session.createThread("app-assistant:test-member");
    const privateResult = await buildFileAttachTool(api!.providers.db, api.providers.blobs, api.baseUrl).execute({ path: "/workspace/revised.docx" }, context(sandbox, id, privateThread.id));
    const privateOutput = parseOutput(privateResult.text);
    await session.attachment.destroy();
    const downloaded = await fetch(output.url);
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get("content-type")).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(downloaded.headers.get("content-disposition")).toContain('attachment; filename="revised.docx"');
    expect(downloaded.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(bytes);
    expect((await fetch(output.url, { headers: { "x-valet-test-user-id": "test-member" } })).status).toBe(404);
    const other = await session.createThread("other");
    expect((await fetch(output.url.replace(thread.id, other.id))).status).toBe(404);
    const { db } = api.providers;
    await db.insert(teams).values({ id: "download-team", orgId: "local-org", name: "Documents", createdAt: Date.now() });
    await db.insert(teamMembers).values([
      { teamId: "download-team", userId: "local-user", role: "admin" },
      { teamId: "download-team", userId: "test-member", role: "member" },
    ]);
    await db.update(agentSessions).set({ ownerType: "team", ownerId: "download-team" }).where(eq(agentSessions.id, id));
    await db.execute(sql`UPDATE engine_sessions SET owner_type = 'team', owner_id = 'download-team' WHERE id = ${id}`);
    expect((await fetch(output.url)).status).toBe(200);
    expect((await fetch(privateOutput.url)).status).toBe(404);
    await db.delete(teamMembers).where(and(eq(teamMembers.teamId, "download-team"), eq(teamMembers.userId, "local-user")));
    expect((await fetch(output.url)).status).toBe(404);

  });

  it("charges durable byte reservations before writes across tool instances", async () => {
    if (!api) throw new Error("missing fixture");
    const { db, blobs } = api.providers;
    const sandbox = await testSandbox();
    await sandbox.writeBinary("/workspace/a.pdf", bytes);
    await sandbox.writeBinary("/workspace/b.pdf", bytes);
    let release = () => {};
    let entered = () => {};
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const put = blobs.put.bind(blobs);
    vi.spyOn(blobs, "put").mockImplementationOnce(async (...args) => { entered(); await gate; await put(...args); });
    const first = buildFileAttachTool(db, blobs, undefined, { bytes: bytes.length, files: 10 }).execute({ path: "/workspace/a.pdf" }, context(sandbox));
    await started;
    const duplicate = await buildFileAttachTool(db, blobs, undefined, { bytes: bytes.length, files: 10 }).execute({ path: "/workspace/a.pdf" }, context(sandbox));
    expect(duplicate.ok).toBe(false);
    expect(duplicate.text).toContain("unfinished storage reservation");
    const second = await buildFileAttachTool(db, blobs, undefined, { bytes: bytes.length, files: 10 }).execute({ path: "/workspace/b.pdf" }, context(sandbox, "other-session", "other-thread"));
    expect(second.ok).toBe(false);
    expect(second.text).toContain("storage is full");
    release();
    expect((await first).ok).toBe(true);
    expect(await db.select().from(generatedFiles)).toHaveLength(1);
    expect((await buildFileAttachTool(db, blobs, undefined, { bytes: bytes.length, files: 10 }).execute({ path: "/workspace/b.pdf" }, context(sandbox))).ok).toBe(false);
  });

  it("deduplicates ready files and caps file count even for empty files", async () => {
    if (!api) throw new Error("missing fixture");
    const { db, blobs } = api.providers;
    const sandbox = await testSandbox();
    await sandbox.writeBinary("/workspace/empty.pdf", new Uint8Array());
    await sandbox.writeBinary("/workspace/another.pdf", new Uint8Array());
    const tool = buildFileAttachTool(db, blobs, undefined, { bytes: 100, files: 1 });
    const first = await tool.execute({ path: "/workspace/empty.pdf" }, context(sandbox));
    const again = await buildFileAttachTool(db, blobs, undefined, { bytes: 100, files: 1 }).execute({ path: "/workspace/empty.pdf" }, context(sandbox));
    expect(first.ok).toBe(true);
    expect(parseOutput(again.text).url).toBe(parseOutput(first.text).url);
    expect((await tool.execute({ path: "/workspace/another.pdf" }, context(sandbox))).ok).toBe(false);
    expect(await db.select().from(generatedFiles)).toHaveLength(1);
  });

  it("removes partial bytes before releasing failed-write capacity", async () => {
    if (!api) throw new Error("missing fixture");
    const { db, blobs } = api.providers;
    const sandbox = await testSandbox();
    await sandbox.writeBinary("/workspace/a.pdf", bytes);
    const put = blobs.put.bind(blobs);
    let partialKey = "";
    vi.spyOn(blobs, "put").mockImplementationOnce(async (...args) => { partialKey = args[0]; await put(...args); throw new Error("partial write"); });
    const tool = buildFileAttachTool(db, blobs, undefined, { bytes: bytes.length, files: 1 });
    expect((await tool.execute({ path: "/workspace/a.pdf" }, context(sandbox))).ok).toBe(false);
    expect(await blobs.get(partialKey)).toBeNull();
    expect(await db.select().from(generatedFiles)).toEqual([]);
    expect((await tool.execute({ path: "/workspace/a.pdf" }, context(sandbox))).ok).toBe(true);
  });

  it("retains charged reservations if cleanup fails and refuses duplicate writers", async () => {
    if (!api) throw new Error("missing fixture");
    const { db, blobs } = api.providers;
    const sandbox = await testSandbox();
    await sandbox.writeBinary("/workspace/a.pdf", bytes);
    await sandbox.writeBinary("/workspace/b.pdf", bytes);
    vi.spyOn(blobs, "put").mockRejectedValueOnce(new Error("write failed"));
    vi.spyOn(blobs, "delete").mockRejectedValueOnce(new Error("cleanup failed"));
    const tool = buildFileAttachTool(db, blobs, undefined, { bytes: bytes.length, files: 1 });
    expect((await tool.execute({ path: "/workspace/a.pdf" }, context(sandbox))).ok).toBe(false);
    const retry = await buildFileAttachTool(db, blobs, undefined, { bytes: bytes.length, files: 1 }).execute({ path: "/workspace/a.pdf" }, context(sandbox));
    expect(retry.ok).toBe(false);
    expect(retry.text).toContain("unfinished storage reservation");
    expect((await tool.execute({ path: "/workspace/b.pdf" }, context(sandbox))).ok).toBe(false);
    const [record] = await db.select().from(generatedFiles);
    expect(record).toMatchObject({ ready: false, bytes: bytes.length });
    expect(await readGeneratedFile(db, blobs, context(sandbox), record.id)).toBeNull();
  });

  it("preserves charged capacity and downloads after reopening the database", async () => {
    directory = await mkdtemp(join(tmpdir(), "generated-files-restart-"));
    const dbPath = join(directory, "pg");
    const blobs = new FsBlobStore(join(directory, "blobs"));
    const sandbox = await testSandbox();
    await sandbox.writeBinary("/workspace/a.pdf", bytes);
    await sandbox.writeBinary("/workspace/b.pdf", bytes);
    let pg = new PGlite(dbPath);
    try {
      await applyAppMigrations(pgDbFromPglite(pg));
      let db = buildAppDb(pg);
      // Simulate a deployed database whose original migration predates this table.
      await db.execute(sql`DROP TABLE generated_files`);
      await applyAppMigrations(pgDbFromPglite(pg));
      await db.insert(orgs).values({ id: "local-org", name: "Local", createdAt: 1 });
      const result = await buildFileAttachTool(db, blobs, undefined, { bytes: bytes.length, files: 1 }).execute({ path: "/workspace/a.pdf" }, context(sandbox));
      expect(result.ok).toBe(true);
      const id = parseOutput(result.text).url.split("/").at(-1);
      if (!id) throw new Error("missing id");
      await pg.close();
      pg = new PGlite(dbPath);
      db = buildAppDb(pg);
      const file = await readGeneratedFile(db, blobs, context(sandbox), id);
      expect(new Uint8Array(await new Response(file?.data).arrayBuffer())).toEqual(bytes);
      expect((await buildFileAttachTool(db, blobs, undefined, { bytes: bytes.length, files: 1 }).execute({ path: "/workspace/b.pdf" }, context(sandbox))).ok).toBe(false);
    } finally { await pg.close(); }
  });

  async function workflowFile(owner: Principal = { type: "user", id: "local-user" }) {
    if (!api) throw new Error("missing fixture");
    const p = api.providers;
    const graph = { version: "dag/v1", nodes: [], edges: [] };
    await p.db.insert(workflowDefinitions).values({ id: "download-workflow", orgId: "local-org", ownerType: owner.type, ownerId: owner.id, name: "Download", definition: graph, createdAt: 1, updatedAt: 1 });
    await p.workflowStore.createRun("download-run", { workflowId: "download-workflow", definitionVersionId: "v1" }, graph, "v1", { ownerType: owner.type, ownerId: owner.id, actorUserId: "local-user" });
    const session = await p.engineHost.workflowSessionFor("wf:download-run:document", { actorUserId: "local-user", orgId: "local-org", owner, workspace: "/workspace" });
    const thread = await session.ensureDefaultThread();
    const { sandbox } = await session.attachment.ensureReady({ timeoutMs: 30_000 });
    await sandbox.writeBinary("/workspace/workflow.pdf", bytes);
    const result = await buildFileAttachTool(p.db, p.blobs, api.baseUrl).execute({ path: "/workspace/workflow.pdf" }, context(sandbox, session.id, thread.id));
    expect(result.ok).toBe(true);
    expect(await p.db.select().from(agentSessions).where(eq(agentSessions.id, session.id))).toEqual([]);
    await session.attachment.destroy();
    return { url: parseOutput(result.text).url, session, thread };
  }

  it("downloads a genuine workflow session file after sandbox destruction with owner isolation", async () => {
    if (!api) throw new Error("missing fixture");
    const { url, thread } = await workflowFile();
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect((await fetch(url, { headers: { "x-valet-test-user-id": "test-member" } })).status).toBe(404);
    expect((await fetch(url.replace(thread.id, "wrong-thread"))).status).toBe(404);
    await api.providers.db.update(workflowDefinitions).set({ orgId: "other-org" }).where(eq(workflowDefinitions.id, "download-workflow"));
    expect((await fetch(url)).status).toBe(404);
  });

  it("checks workflow team membership, private origin, and private event visibility", async () => {
    if (!api) throw new Error("missing fixture");
    const p = api.providers;
    await p.db.insert(teams).values({ id: "download-team", orgId: "local-org", name: "Documents", createdAt: 1 });
    await p.db.insert(teamMembers).values([{ teamId: "download-team", userId: "local-user", role: "admin" }, { teamId: "download-team", userId: "test-member", role: "member" }]);
    const { url } = await workflowFile({ type: "team", id: "download-team" });
    const member = { headers: { "x-valet-test-user-id": "test-member" } };
    expect((await fetch(url, member)).status).toBe(200);
    const execution = await ensureAssistantExecution(p, { type: "team", id: "download-team" }, { orgId: "local-org", actorUserId: "local-user" }, "app-assistant:local-user");
    const privateThread = await execution.session.ensureDefaultThread();
    await p.db.update(workflowRuns).set({ params: { workflowId: "download-workflow", definitionVersionId: "v1", origin: { assistantSessionId: execution.sessionId, threadId: privateThread.id } } }).where(eq(workflowRuns.id, "download-run"));
    expect((await fetch(url)).status).toBe(200);
    expect((await fetch(url, member)).status).toBe(404);
    expect((await fetch(`${api.baseUrl}/api/workflows/runs/download-run`, member)).status).toBe(404);
    // Missing private origin fails closed except for the recorded initiating person.
    const params = { workflowId: "download-workflow", definitionVersionId: "v1", origin: { assistantSessionId: "gone-private-session", threadId: "gone-thread" } };
    await p.db.update(workflowRuns).set({ params }).where(eq(workflowRuns.id, "download-run"));
    expect((await fetch(url)).status).toBe(200);
    expect((await fetch(url, member)).status).toBe(404);
    await p.engineCredentials.save({ type: "org", id: "local-org" }, "slack", { type: "oauth2", accessToken: "xoxb-test" });
    await linkIdentity(p.db, { provider: "slack", externalId: "UOWNER", userId: "local-user" });
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const target = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (target.hostname !== "slack.com") return realFetch(input, init);
      return Response.json(target.pathname.endsWith("conversations.members") ? { ok: true, members: ["UOWNER"] } : { ok: true, channel: { name: "private", is_private: true } });
    });
    await p.db.update(workflowRuns).set({ params: { workflowId: params.workflowId, definitionVersionId: "v1", input: { type: "event", data: { key: "slack.message", refs: { channel: "CDOWNLOADPRIVATE" } } } } }).where(eq(workflowRuns.id, "download-run"));
    expect((await fetch(url)).status).toBe(200);
    expect((await fetch(url, member)).status).toBe(404);
    expect((await fetch(`${api.baseUrl}/api/workflows/runs/download-run`, member)).status).toBe(404);
    await p.db.delete(teamMembers).where(and(eq(teamMembers.teamId, "download-team"), eq(teamMembers.userId, "local-user")));
    expect((await fetch(url)).status).toBe(404);
  });

});
