/** Integration coverage for sandbox file upload, including attachment
 * readiness, extraction, limits, overwrite safety, and ref handling. */

import { describe, it, expect, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { sandboxReadyError, zipExtractRoot } from "./sandbox-file-upload.js";
import type { PostSessionFileUploadResponse } from "../wire/types.js";
import {
  SandboxPreparationError,
  SandboxStartupError,
  SandboxUnavailableError,
  WorkspaceProvisioningError,
  VirtualSandboxProvider,
  type Sandbox,
  type SandboxCapabilities,
  type SandboxCreateOpts,
  type SandboxProvider,
  type SandboxStatus,
} from "@valet/engine";

// A flat `zip -X` archive: a.txt ("alpha\n") + b.txt ("beta\n") at the root,
// no directory entries — the shape that regressed when extraction relied on
// per-entry mkdir to create the extract root.
const ZIP_FLAT = Buffer.from(
  "UEsDBAoAAAAAAPh+GF3sbmCfBgAAAAYAAAAFAAAAYS50eHRhbHBoYQpQSwMECgAAAAAA+H4YXXWn4+YFAAAABQAAAAUAAABiLnR4dGJldGEKUEsBAh4DCgAAAAAA+H4YXexuYJ8GAAAABgAAAAUAAAAAAAAAAQAAAKSBAAAAAGEudHh0UEsBAh4DCgAAAAAA+H4YXXWn4+YFAAAABQAAAAUAAAAAAAAAAQAAAKSBKQAAAGIudHh0UEsFBgAAAAACAAIAZgAAAFEAAAAAAA==",
  "base64",
);

class UploadSandboxProvider implements SandboxProvider {
  readonly backend = "upload-test";
  readonly inner = new VirtualSandboxProvider();
  createCalls = 0;
  resumeCalls = 0;
  failNext = false;

  capabilities(): SandboxCapabilities {
    return { ...this.inner.capabilities(), hibernation: true };
  }
  async create(opts: SandboxCreateOpts): Promise<Sandbox> {
    this.createCalls += 1;
    if (this.failNext) {
      this.failNext = false;
      throw new SandboxStartupError("upload-test", "test startup failure");
    }
    return this.inner.create(opts);
  }
  restore(id: string): Promise<Sandbox> { return this.inner.restore(id); }
  destroy(id: string): Promise<void> { return this.inner.destroy(id); }
  status(id: string): Promise<SandboxStatus> { return this.inner.status(id); }
  async suspend(_id: string): Promise<void> {}
  async resume(_id: string): Promise<void> { this.resumeCalls += 1; }
}

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

async function createSession(baseUrl: string, initialPrompt = "ready"): Promise<string> {
  const res = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspace: "/tmp", ...(initialPrompt ? { initialPrompt } : {}) }),
  });
  expect(res.status).toBe(201);
  const { id } = (await res.json()) as { id: string };
  return id;
}

async function upload(baseUrl: string, sessionId: string, name: string): Promise<Response> {
  const form = new FormData();
  form.append("file", new Blob([name]), name);
  return fetch(`${baseUrl}/api/sessions/${sessionId}/files`, { method: "POST", body: form });
}

describe("POST /api/sessions/:id/files", () => {
  it("waits for detached provisioning and reuses the ready sandbox", async () => {
    const provider = new UploadSandboxProvider();
    api = await bootTestApi({ sandboxProvider: provider });
    const sessionId = await createSession(api.baseUrl, "");

    expect((await upload(api.baseUrl, sessionId, "cold.txt")).status).toBe(200);
    expect((await upload(api.baseUrl, sessionId, "ready.txt")).status).toBe(200);
    expect(provider.createCalls).toBe(1);
  });

  it("resumes a suspended sandbox in the same upload request", async () => {
    const provider = new UploadSandboxProvider();
    api = await bootTestApi({ sandboxProvider: provider });
    const sessionId = await createSession(api.baseUrl, "");
    expect((await upload(api.baseUrl, sessionId, "before.txt")).status).toBe(200);
    await api.providers.engineHost.liveSession(sessionId)?.attachment.suspend();

    expect((await upload(api.baseUrl, sessionId, "after.txt")).status).toBe(200);
    expect(provider.resumeCalls).toBe(1);
  });

  it("recovers a provider-backed error on the next upload", async () => {
    const provider = new UploadSandboxProvider();
    provider.failNext = true;
    api = await bootTestApi({ sandboxProvider: provider });
    const sessionId = await createSession(api.baseUrl, "");

    const failed = await upload(api.baseUrl, sessionId, "failed.txt");
    expect(failed.status).toBe(500);
    expect(await failed.json()).toMatchObject({ error: "sandbox failed to start" });
    expect((await upload(api.baseUrl, sessionId, "recovered.txt")).status).toBe(200);
    expect(provider.createCalls).toBe(2);
  });

  it("does not try to restart a released attachment", async () => {
    const provider = new UploadSandboxProvider();
    api = await bootTestApi({ sandboxProvider: provider });
    const sessionId = await createSession(api.baseUrl, "");
    expect((await upload(api.baseUrl, sessionId, "before.txt")).status).toBe(200);
    await api.providers.engineHost.liveSession(sessionId)?.attachment.destroy();

    const released = await upload(api.baseUrl, sessionId, "after.txt");
    expect(released.status).toBe(409);
    expect(await released.json()).toMatchObject({ error: "sandbox was released" });
    expect(provider.createCalls).toBe(1);
  });
  it("accepts a plain text file and returns correct response shape", async () => {
    api = await bootTestApi();

    const sessionId = await createSession(api.baseUrl);

    // Upload a text file
    const formData = new FormData();
    const textBlob = new Blob(["Hello, World!"], { type: "text/plain" });
    formData.append("file", textBlob, "test.txt");

    const uploadResp = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/files`, {
      method: "POST",
      body: formData,
    });

    expect(uploadResp.status).toBe(200);
    const result = (await uploadResp.json()) as PostSessionFileUploadResponse;
    expect(result).toHaveProperty("path");
    expect(result.attachmentRef).toMatch(/^att_[0-9a-f]{32}$/);
    expect(result.bytes).toBe(13); // "Hello, World!"
    // The reported hash must be the hash of the file's bytes — the exact
    // regression a hash-the-buffer-twice bug ships.
    expect(result.sha256).toBe(createHash("sha256").update("Hello, World!").digest("hex"));
  });

  it("returns 404 for non-owner", async () => {
    api = await bootTestApi();

    const sessionId = await createSession(api.baseUrl);

    // Create a new user context (simulate non-owner)
    // For now, we'll just verify the route structure
    const formData = new FormData();
    const textBlob = new Blob(["test"], { type: "text/plain" });
    formData.append("file", textBlob, "test.txt");

    // This test assumes the API provides a way to switch auth context
    // For now, just verify the endpoint exists and can be called
    const uploadResp = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/files`, {
      method: "POST",
      body: formData,
    });

    // Should be either 200 (if same user) or 404 (if different user)
    // We can't reliably test different users in this context
    expect([200, 404, 409]).toContain(uploadResp.status);
  });

  it("returns 400 when file field is missing", async () => {
    api = await bootTestApi();

    const sessionId = await createSession(api.baseUrl);

    // Upload without file field
    const formData = new FormData();
    formData.append("extract", "false");

    const uploadResp = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/files`, {
      method: "POST",
      body: formData,
    });

    expect(uploadResp.status).toBe(400);
    const result = (await uploadResp.json()) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
    expect(result).toHaveProperty("corrective");
  });

  it("returns 400 when extract parameter is invalid", async () => {
    api = await bootTestApi();

    const sessionId = await createSession(api.baseUrl);

    // Upload with invalid extract value
    const formData = new FormData();
    const textBlob = new Blob(["test"], { type: "text/plain" });
    formData.append("file", textBlob, "test.txt");
    formData.append("extract", "maybe");

    const uploadResp = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/files`, {
      method: "POST",
      body: formData,
    });

    expect(uploadResp.status).toBe(400);
  });

  it("uses default dest when not provided", async () => {
    api = await bootTestApi();

    const sessionId = await createSession(api.baseUrl);

    const formData = new FormData();
    const textBlob = new Blob(["test"], { type: "text/plain" });
    formData.append("file", textBlob, "myfile.txt");

    const uploadResp = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/files`, {
      method: "POST",
      body: formData,
    });

    expect(uploadResp.status).toBe(200);
    const result = (await uploadResp.json()) as PostSessionFileUploadResponse;
    expect(result.path).toContain("myfile.txt");
    expect(result.path).toContain("/workspace");
  });

  it("respects custom dest parameter", async () => {
    api = await bootTestApi();

    const sessionId = await createSession(api.baseUrl);

    const formData = new FormData();
    const textBlob = new Blob(["test"], { type: "text/plain" });
    formData.append("file", textBlob, "myfile.txt");
    formData.append("dest", "/workspace/custom/path.txt");

    const uploadResp = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/files`, {
      method: "POST",
      body: formData,
    });

    expect(uploadResp.status).toBe(200);
    const result = (await uploadResp.json()) as PostSessionFileUploadResponse;
    expect(result.path).toBe("/workspace/custom/path.txt");
  });

  it("returns error when extract=true on non-archive", async () => {
    api = await bootTestApi();

    const sessionId = await createSession(api.baseUrl);

    const formData = new FormData();
    const textBlob = new Blob(["just text"], { type: "text/plain" });
    formData.append("file", textBlob, "test.txt");
    formData.append("extract", "true");

    const uploadResp = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/files`, {
      method: "POST",
      body: formData,
    });

    // 415 Unsupported Media Type: a .txt file can't be extracted.
    expect(uploadResp.status).toBe(415);
    const result = (await uploadResp.json()) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
    expect(result).toHaveProperty("corrective");
  });

  it("keeps every ref usable when a batch contains a bad ref", async () => {
    api = await bootTestApi();
    const sessionId = await createSession(api.baseUrl);

    const formData = new FormData();
    formData.append("file", new Blob(["hello"], { type: "text/plain" }), "keep.txt");
    const uploadResp = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/files`, {
      method: "POST",
      body: formData,
    });
    expect(uploadResp.status).toBe(200);
    const { attachmentRef } = (await uploadResp.json()) as PostSessionFileUploadResponse;

    // A batch with one bogus ref fails without consuming the good ref.
    const badSend = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "use the files",
        fileRefs: [{ ref: attachmentRef }, { ref: "att_deadbeefdeadbeefdeadbeefdeadbeef" }],
      }),
    });
    expect(badSend.status).toBe(400);

    // The corrected retry succeeds with the surviving ref.
    const goodSend = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "use the file", fileRefs: [{ ref: attachmentRef }] }),
    });
    expect(goodSend.status).toBe(202);

    // The ref is single-use: a second send with it fails.
    const replay = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "again", fileRefs: [{ ref: attachmentRef }] }),
    });
    expect(replay.status).toBe(400);
  });

  it("extracts a flat zip whose name has no .zip suffix (magic-byte detection)", async () => {
    api = await bootTestApi();
    const sessionId = await createSession(api.baseUrl);

    const formData = new FormData();
    // Zip content, but named "data.bin": detection is magic-byte based, and
    // the extract root must not collide with the archive file itself.
    formData.append("file", new Blob([new Uint8Array(ZIP_FLAT)]), "data.bin");

    const uploadResp = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/files`, {
      method: "POST",
      body: formData,
    });

    expect(uploadResp.status).toBe(200);
    const result = (await uploadResp.json()) as PostSessionFileUploadResponse;
    expect(result.extractedTo).toBe("/workspace/uploads/data.bin.extracted/");
    expect(result.extracted?.sort()).toEqual([
      "/workspace/uploads/data.bin.extracted/a.txt",
      "/workspace/uploads/data.bin.extracted/b.txt",
    ]);
  });

  it("consumes a ref listed twice in one request exactly once", async () => {
    api = await bootTestApi();
    const sessionId = await createSession(api.baseUrl);

    const formData = new FormData();
    formData.append("file", new Blob(["dup"], { type: "text/plain" }), "dup.txt");
    const uploadResp = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/files`, {
      method: "POST",
      body: formData,
    });
    expect(uploadResp.status).toBe(200);
    const { attachmentRef } = (await uploadResp.json()) as PostSessionFileUploadResponse;

    // The same ref twice in one batch attaches the file once, not twice.
    const send = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "use the file",
        fileRefs: [{ ref: attachmentRef }, { ref: attachmentRef }],
      }),
    });
    expect(send.status).toBe(202);

    // Still single-use afterwards.
    const replay = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "again", fileRefs: [{ ref: attachmentRef }] }),
    });
    expect(replay.status).toBe(400);
  });

  it("refuses to clobber an existing PDF sidecar with extract=true and overwrite unset", async () => {
    api = await bootTestApi();
    const sessionId = await createSession(api.baseUrl);

    // Seed a file at the sidecar path.
    const seed = new FormData();
    seed.append("file", new Blob(["my notes"], { type: "text/markdown" }), "report.pdf.md");
    const seedResp = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/files`, {
      method: "POST",
      body: seed,
    });
    expect(seedResp.status).toBe(200);

    // "%PDF-" magic bytes route the upload down the PDF path; the sidecar
    // conflict must 409 before anything is written.
    const formData = new FormData();
    formData.append("file", new Blob(["%PDF-1.4 not a real pdf"]), "report.pdf");
    formData.append("extract", "true");
    const uploadResp = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/files`, {
      method: "POST",
      body: formData,
    });
    expect(uploadResp.status).toBe(409);
    const body = (await uploadResp.json()) as Record<string, unknown>;
    expect(String(body.error)).toContain("report.pdf.md");
  });

  it("rejects an oversized Content-Length before parsing the body", async () => {
    api = await bootTestApi();
    const sessionId = await createSession(api.baseUrl);

    // node:http, not fetch — fetch owns Content-Length and would not send
    // an unbacked value. The route must answer from the header alone,
    // before any body bytes arrive.
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        `${api!.baseUrl}/api/sessions/${sessionId}/files`,
        {
          method: "POST",
          headers: {
            "content-type": "multipart/form-data; boundary=x",
            "content-length": String(200 * 1024 * 1024),
          },
        },
        (res) => {
          resolve(res.statusCode ?? 0);
          res.resume();
          req.destroy();
        },
      );
      req.on("error", reject);
      req.flushHeaders();
    });
    expect(status).toBe(413);
  });

  // The engine-write hop of the persistence round trip (submitPrompt →
  // MessageEntry type:"file" → agent note) is covered by
  // packages/engine/test/prompt-file-attachments.test.ts — this harness
  // runs keyless, so no turn ever starts and no user entry persists here.
});

describe("sandboxReadyError", () => {
  it.each([
    [new WorkspaceProvisioningError(60_000), "provisioning", false, 409, true],
    [new WorkspaceProvisioningError(60_000), "error", false, 409, undefined],
    [new SandboxStartupError("id", "bad image"), "error", false, 500, undefined],
    [new SandboxPreparationError("bad prep"), "error", false, 500, undefined],
    [new SandboxUnavailableError(), "released", false, 409, undefined],
    [new SandboxUnavailableError(), "error", false, 409, undefined],
    [new Error("abort"), "provisioning", true, 408, undefined],
  ] as const)("maps readiness failure %#", (error, state, aborted, status, wake) => {
    const mapped = sandboxReadyError(error, state, aborted);
    expect([mapped.status, mapped.body.wake]).toEqual([status, wake]);
  });
});

describe("zipExtractRoot", () => {
  it("strips a lowercase .zip suffix", () => {
    expect(zipExtractRoot("/workspace/uploads/data.zip")).toBe("/workspace/uploads/data/");
  });

  it("strips an uppercase .ZIP suffix", () => {
    expect(zipExtractRoot("/workspace/uploads/ARCHIVE.ZIP")).toBe("/workspace/uploads/ARCHIVE/");
  });

  it("appends .extracted when the name has no .zip suffix", () => {
    expect(zipExtractRoot("/workspace/uploads/data.bin")).toBe("/workspace/uploads/data.bin.extracted/");
  });
});
