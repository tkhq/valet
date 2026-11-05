import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import type { PluginActionContext } from "@valet/engine";
import { bootTestApi, type TestApi } from "./_setup.js";
import { profilePictureActions } from "../services/profile-picture-actions.js";

let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); vi.unstubAllEnvs(); });

async function setup() {
  api = await bootTestApi({ plugins: [] });
  const { engineStore, blobs } = api.providers;
  await engineStore.saveSession({ id: "avatar-session", orgId: "local-org", userId: "local-user", owner: { type: "user", id: "local-user" }, workspace: "/tmp", purpose: "interactive", status: "running", createdAt: 1, updatedAt: 1 });
  for (const id of ["current", "other"]) {
    await engineStore.saveThread("avatar-session", { id, sessionId: "avatar-session", key: id, status: "active", queueMode: "followup", createdAt: 1, updatedAt: 1 });
  }
  const bytes = await sharp({ create: { width: 800, height: 400, channels: 3, background: "red" } }).png().toBuffer();
  for (const id of ["current", "other"]) {
    await engineStore.appendEntries("avatar-session", id, [{ id: `${id}-image`, sessionId: "avatar-session", threadId: id, parentId: null, type: "message", role: "user", content: "Use this photo", createdAt: 1,
      attachments: [{ type: "image", mimeType: "image/png", url: `data:image/png;base64,${bytes.toString("base64")}` }],
    }]);
  }
  // The action reads only host-stamped identity; sandbox and credential methods are unused.
  const ctx = { orgId: "local-org", userId: "local-user", sessionId: "avatar-session", threadId: "current" } as PluginActionContext;
  const action = profilePictureActions(engineStore, blobs, () => "https://valet.example").actions[0];
  if (!action) throw new Error("missing avatar action");
  return { action, ctx, baseUrl: api.baseUrl, engineStore };
}

describe("chat image to workflow avatar", () => {
  it("publishes a normalized copy that Slack can read, with a stable URL on retry", async () => {
    const { action, ctx, baseUrl } = await setup();
    const result = await action.execute({}, ctx);
    expect(result.success).toBe(true);
    const data = result.data as { avatar_url: string };
    expect(data.avatar_url).toMatch(/^https:\/\/valet.example\/avatars\/workflows\/[a-f0-9]{64}\.webp$/);
    const response = await fetch(`${baseUrl}${new URL(data.avatar_url).pathname}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(await sharp(await response.arrayBuffer()).metadata()).toMatchObject({ format: "webp", width: 512, height: 256 });
    expect(await action.execute({}, ctx)).toEqual(result);
  });

  it("cannot select another chat's image or publish under another organization", async () => {
    const { action, ctx } = await setup();
    expect((await action.execute({ message_id: "other-image" }, ctx)).success).toBe(false);
    expect((await action.execute({}, { ...ctx, orgId: "foreign" })).success).toBe(false);
  });

  it("refuses missing and malformed images without publishing arbitrary bytes", async () => {
    const { action, ctx, engineStore } = await setup();
    expect((await action.execute({ image_index: 4 }, ctx)).success).toBe(false);
    await engineStore.appendEntries("avatar-session", "current", [{ id: "invalid", sessionId: "avatar-session", threadId: "current", parentId: null, type: "message", role: "user", content: "bad", createdAt: 2,
      attachments: [{ type: "image", mimeType: "image/png", url: "data:image/png;base64,SGVsbG8=" }],
    }]);
    expect((await action.execute({ message_id: "invalid" }, ctx)).success).toBe(false);
  });
});

it("publishes the photo supplied as a question answer", async () => {
  const { action, ctx, engineStore } = await setup();
  const bytes = await sharp({ create: { width: 32, height: 32, channels: 3, background: "blue" } }).png().toBuffer();
  await engineStore.appendEntries(ctx.sessionId, ctx.threadId, [{ id: "photo-answer", sessionId: ctx.sessionId, threadId: ctx.threadId, parentId: null, type: "decision_gate", createdAt: 3,
    gate: { id: "question", sessionId: ctx.sessionId, threadId: ctx.threadId, type: "question", queueItemId: "q", resumeKey: "photo", ordinal: 0, title: "Which photo?", actions: [], status: "resolved", createdAt: 2, updatedAt: 3 },
    resolution: { resolvedBy: "local-user", resolvedAt: 3, attachments: [{ url: `data:image/png;base64,${bytes.toString("base64")}`, mimeType: "image/png" }] },
  }]);
  const selected = await action.execute({ message_id: "photo-answer" }, ctx);
  expect(selected.success).toBe(true);
  expect(await action.execute({}, ctx)).toEqual(selected);
});
