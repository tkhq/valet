import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  NoneWorkspaceStore,
  checkpointDataKey,
  checkpointManifestKey,
  latestPointerKey,
  validateWorkspaceRef,
  workspaceKey,
  workspaceObjectPrefix,
  type WorkspaceRef,
} from "../src/sandbox/workspace-store.js";

// The spec's worked example, reused by every part.
const ref: WorkspaceRef = {
  orgId: "org_39828000-1c89-4735-874e-2150e09dc225",
  ownerId: "user_zeke",
  workspaceId: "root-valet-assistants-asst-11111111-2222-3333-4444-555555555555",
};

describe("workspace key layout", () => {
  it("derives the worked-example workspace key", () => {
    expect(workspaceKey(ref)).toBe(
      "org_39828000-1c89-4735-874e-2150e09dc225/user_zeke/root-valet-assistants-asst-11111111-2222-3333-4444-555555555555",
    );
  });

  it("lays out data, manifest, and latest under the workspace key", () => {
    expect(checkpointDataKey("", ref, "ckpt-1")).toBe(
      `${workspaceKey(ref)}/checkpoints/ckpt-1/data.tar.gz`,
    );
    expect(checkpointManifestKey("", ref, "ckpt-1")).toBe(
      `${workspaceKey(ref)}/checkpoints/ckpt-1/manifest.json`,
    );
    expect(latestPointerKey("", ref)).toBe(`${workspaceKey(ref)}/latest`);
    expect(workspaceObjectPrefix("", ref)).toBe(`${workspaceKey(ref)}/`);
  });

  it("applies an operator prefix without doubling slashes", () => {
    expect(latestPointerKey("tenants/", ref)).toBe(`tenants/${workspaceKey(ref)}/latest`);
    expect(latestPointerKey("tenants", ref)).toBe(`tenants/${workspaceKey(ref)}/latest`);
  });

  it("rejects an empty orgId or ownerId (INV-3)", () => {
    expect(() => workspaceKey({ ...ref, orgId: "" })).toThrow(/orgId/);
    expect(() => workspaceKey({ ...ref, ownerId: "" })).toThrow(/ownerId/);
    expect(() => workspaceKey({ ...ref, workspaceId: "" })).toThrow(/workspaceId/);
  });

  it("rejects segments containing '/' or whitespace (cross-prefix containment)", () => {
    expect(() => validateWorkspaceRef({ ...ref, workspaceId: "a/b" })).toThrow(/workspaceId/);
    expect(() => validateWorkspaceRef({ ...ref, ownerId: "user zeke" })).toThrow(/ownerId/);
  });
});

describe("none backend", () => {
  it("reports no checkpoint, restores nothing, commits nothing", async () => {
    const store = new NoneWorkspaceStore();
    expect(await store.latest()).toBeNull();
    expect(await store.restore()).toBeNull();
    const manifest = await store.checkpoint(ref, Readable.from(["ignored"]), { createdAtMs: 42 });
    expect(manifest).toEqual({ checkpointId: "none", createdAtMs: 42, sizeBytes: 0, entryCount: 0 });
    expect(await store.latest()).toBeNull();
    await store.purge();
  });
});
