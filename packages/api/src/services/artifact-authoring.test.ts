import { beforeEach, describe, expect, it } from "vitest";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { artifactComments, orgMembers, orgs, users } from "../schema/index.js";
import {
  applyArtifactEdit, createArtifactEditRequest, getArtifactById, getArtifactSnapshot,
  listArtifactComments, listArtifactVersions, publishArtifact, restoreArtifactVersion,
  setArtifactSharedVersion, setArtifactVisibility,
} from "./artifacts.js";

const scope = { owner: { type: "user" as const, id: "u1" }, actorUserId: "u1" };

describe("artifact authoring revisions", () => {
  let db: AppDb;
  beforeEach(async () => {
    ({ appDb: db } = await freshTestPgDb());
    await db.insert(orgs).values({ id: "org", name: "Org", createdAt: 1 });
    await db.insert(users).values({ id: "u1", email: "u1@test.dev", name: "User", role: "member" });
    await db.insert(orgMembers).values({ orgId: "org", userId: "u1", role: "member" });
  });
  const publish = (content = "# Plan\n\nKeep before. Change me. Keep after.") => publishArtifact(db, scope, {
    orgId: "org", key: "plan", content, format: "markdown", sourceSessionId: "session", sourceThreadId: "thread",
  });

  it("bounds an edit to the persisted selection and preserves audience, pin and provenance", async () => {
    const original = await publish();
    await setArtifactSharedVersion(db, original.id, 1);
    await setArtifactVisibility(db, original.id, "public", "u1");
    const request = await createArtifactEditRequest(db, scope, "org", original.id, {
      baseVersion: 1, instruction: "Improve this sentence", selection: { text: "Change me." },
    });
    const updated = await applyArtifactEdit(db, scope, "org", original.id, { requestId: request.id, replacement: "Changed." });
    expect(updated.content).toBe("# Plan\n\nKeep before. Changed. Keep after.");
    expect(updated).toMatchObject({ version: 2, token: original.token, visibility: "public", sharedVersion: 1, sourceSessionId: "session", sourceThreadId: "thread" });
    expect((await getArtifactSnapshot(db, updated, 1, "u1")).content).toBe(original.content);
    expect((await listArtifactVersions(db, original.id)).map(row => row.version)).toEqual([2, 1]);
    await expect(applyArtifactEdit(db, scope, "org", original.id, { requestId: request.id, replacement: "Again" })).rejects.toMatchObject({ code: "artifact_version_conflict" });
  });

  it("rejects stale, ambiguous, empty and invalid offset selections without storing requests", async () => {
    const row = await publish("same same");
    for (const input of [
      { baseVersion: 2, selection: { text: "same" } },
      { baseVersion: 1, selection: { text: "same" } },
      { baseVersion: 1, selection: { text: "" } },
      { baseVersion: 1, selection: { text: "same", start: 1, end: 5 } },
      { baseVersion: 1, selection: { text: "same", start: 0 } },
    ]) {
      await expect(createArtifactEditRequest(db, scope, "org", row.id, { ...input, instruction: "Edit" })).rejects.toThrow();
    }
    expect(await db.select().from(artifactComments)).toEqual([]);
    expect((await getArtifactById(db, row.id))?.version).toBe(1);
  });

  it("accepts validated offsets for repeated text and rejects another artifact's request", async () => {
    const row = await publish("same same");
    const request = await createArtifactEditRequest(db, scope, "org", row.id, {
      baseVersion: 1, instruction: "Change the second", selection: { text: "same", start: 5, end: 9 },
    });
    const other = await publishArtifact(db, scope, { orgId: "org", key: "other", content: "same same", format: "markdown" });
    await expect(applyArtifactEdit(db, scope, "org", other.id, { requestId: request.id, replacement: "different" })).rejects.toThrow();
    expect((await applyArtifactEdit(db, scope, "org", row.id, { requestId: request.id, replacement: "different" })).content).toBe("same different");
  });

  it("restores by appending a snapshot while keeping current metadata and immutable history", async () => {
    const original = await publish();
    const latest = await publish("# New title\n\nSecond revision.");
    await setArtifactSharedVersion(db, latest.id, 2);
    await setArtifactVisibility(db, latest.id, "public", "u1");
    const restored = await restoreArtifactVersion(db, scope, "org", latest.id, { version: 1, baseVersion: 2 });
    expect(restored).toMatchObject({ version: 3, title: original.title, content: original.content, token: original.token, sharedVersion: 2, visibility: "public", sourceSessionId: "session", sourceThreadId: "thread" });
    expect((await getArtifactSnapshot(db, restored, 2, "u1")).content).toBe(latest.content);
    await expect(restoreArtifactVersion(db, scope, "org", latest.id, { version: 1, baseVersion: 2 })).rejects.toMatchObject({ code: "artifact_version_conflict" });
    expect((await listArtifactVersions(db, latest.id)).map(row => row.version)).toEqual([3, 2, 1]);
  });

  it("resolves supplied element ids to the full raw HTML range, including attributes", async () => {
    const content = '<section class="keep"><div data-vdid="hero" class="old">Hello <b>world</b></div><p>Keep</p></section>';
    const row = await publishArtifact(db, scope, { orgId: "org", key: "page", content, format: "html" });
    const request = await createArtifactEditRequest(db, scope, "org", row.id, {
      baseVersion: 1, instruction: "Change the layout", selection: { kind: "element", text: "Hello world", vdid: "hero" },
    });
    const updated = await applyArtifactEdit(db, scope, "org", row.id, { requestId: request.id, replacement: '<div data-vdid="hero" class="new">Hello world</div>' });
    expect(updated.content).toBe('<section class="keep"><div data-vdid="hero" class="new">Hello world</div><p>Keep</p></section>');
  });
  it("resolves explicit ids on elements outside the generated selector", async () => {
    const content = '<main data-vdid="layout"><header data-vdid="header"><span data-vdid="label">Hello</span></header><div data-vdid="sections"><section>Body</section></div></main>';
    for (const [vdid, text, oldText] of [
      ["label", "Hello", '<span data-vdid="label">Hello</span>'],
      ["header", "Hello", '<header data-vdid="header"><span data-vdid="label">Hello</span></header>'],
      ["sections", "Body", '<div data-vdid="sections"><section>Body</section></div>'],
    ]) {
      const row = await publishArtifact(db, scope, { orgId: "org", key: `explicit-${vdid}`, content, format: "html" });
      const request = await createArtifactEditRequest(db, scope, "org", row.id, {
        baseVersion: 1, instruction: "Change style", selection: { kind: "element", text, vdid },
      });
      const updated = await applyArtifactEdit(db, scope, "org", row.id, { requestId: request.id, replacement: "<aside>New</aside>" });
      expect(updated.content).toBe(content.replace(oldText, "<aside>New</aside>"));
    }
  });

  it("admits only one concurrent revision operation for the same base", async () => {
    const row = await publish();
    const results = await Promise.allSettled([
      restoreArtifactVersion(db, scope, "org", row.id, { version: 1, baseVersion: 1 }),
      restoreArtifactVersion(db, scope, "org", row.id, { version: 1, baseVersion: 1 }),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected")).toMatchObject({ status: "rejected", reason: { code: "artifact_version_conflict" } });
    expect((await listArtifactVersions(db, row.id)).map(row => row.version)).toEqual([2, 1]);
  });

});
