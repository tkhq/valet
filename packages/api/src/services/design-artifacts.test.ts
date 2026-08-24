/**
 * Design artifact service tests (spec §Data Model + §Tools): seed from a
 * template, revision write path with the parentRevision fence, revert as
 * append, comments, and the host_event emission shape the WS bridge maps.
 */
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pgDbFromPglite } from "@valet/store-postgres";
import type { BusEvent } from "@valet/engine";
import { applyAppMigrations, buildAppDb, type AppDb } from "../lib/drizzle.js";
import { agentSessions } from "../schema/index.js";
import {
  addComment,
  emitDesignEvent,
  getArtifactBySession,
  listComments,
  listRevisions,
  nextRevisionId,
  resolveComment,
  revertToRevision,
  seedArtifact,
  updateArtifact,
} from "./design-artifacts.js";
import { busEventToWire } from "../engine/bridge.js";

const SESSION_ID = "s_design_test_1";

function editDoc(marker: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="valet-design" content="v=1; template=document"></head>
<body><h1>${marker}</h1><p>Body.</p></body>
</html>`;
}

describe("design artifact service", () => {
  const pglite = new PGlite();
  const raw = pgDbFromPglite(pglite);
  let db: AppDb;

  beforeAll(async () => {
    await applyAppMigrations(raw);
    db = buildAppDb(pglite);
    const now = Date.now();
    await db.insert(agentSessions).values({
      id: SESSION_ID,
      userId: "u1",
      orgId: "org1",
      workspace: "design",
      ownerType: "user",
      ownerId: "u1",
      kind: "design",
      template: "document",
      createdAt: now,
      updatedAt: now,
    });
  });

  afterAll(async () => {
    await raw.close();
  });

  it("nextRevisionId increments and pads", () => {
    expect(nextRevisionId(null)).toBe("r-001");
    expect(nextRevisionId("r-001")).toBe("r-002");
    expect(nextRevisionId("r-099")).toBe("r-100");
    expect(nextRevisionId("r-999")).toBe("r-1000");
  });

  it("seeds r-001 from the template starter with vdids applied", async () => {
    const artifact = await seedArtifact(db, { sessionId: SESSION_ID, template: "document" });
    expect(artifact.currentRevision).toBe("r-001");

    const detail = await getArtifactBySession(db, SESSION_ID);
    expect(detail).not.toBeNull();
    expect(detail?.content).toContain("valet-design");
    expect(detail?.content).toMatch(/data-vdid="[0-9a-f_]+"/);
  });

  it("update writes r-002 and moves the pointer", async () => {
    const result = await updateArtifact(db, {
      sessionId: SESSION_ID,
      content: editDoc("Edited"),
      summary: "Shorten the headline",
      turnId: "entry-1",
    });
    expect(result.revision.revision).toBe("r-002");
    expect(result.artifact.currentRevision).toBe("r-002");

    const detail = await getArtifactBySession(db, SESSION_ID);
    expect(detail?.content).toContain("Edited");
  });

  it("rejects a stale parentRevision with a corrective message", async () => {
    await expect(
      updateArtifact(db, {
        sessionId: SESSION_ID,
        content: editDoc("Stale"),
        summary: "stale write",
        parentRevision: "r-001",
      }),
    ).rejects.toThrow(/Stale edit.*r-002/);
  });

  it("rejects an explicit unknown format version (no silent migration)", async () => {
    const doc = editDoc("VersionTest").replace("v=1", "v=9");
    await expect(updateArtifact(db, { sessionId: SESSION_ID, content: doc, summary: "x" })).rejects.toThrow(
      /v=9/,
    );
  });

  it("revert appends a new revision with the old content", async () => {
    const result = await revertToRevision(db, { sessionId: SESSION_ID, revision: "r-001" });
    expect(result.revision.revision).toBe("r-003");
    const detail = await getArtifactBySession(db, SESSION_ID);
    expect(detail?.content).not.toContain("Edited");

    const revisions = await listRevisions(db, result.artifact.id);
    expect(revisions.map((r) => r.revision)).toEqual(["r-003", "r-002", "r-001"]);
  });

  it("comments: add, list, resolve", async () => {
    const comment = await addComment(db, {
      sessionId: SESSION_ID,
      vdid: "a3c7f2e8b1d4a6c9",
      body: "Make it shorter",
      authorUserId: "u1",
    });
    expect(comment.resolvedAt).toBeNull();

    const listed = await listComments(db, SESSION_ID);
    expect(listed).toHaveLength(1);

    const resolved = await resolveComment(db, { sessionId: SESSION_ID, commentId: comment.id });
    expect(resolved.resolvedAt).not.toBeNull();
  });

  it("rejects a rewrite that echoes design_read's image-elision placeholder", async () => {
    const echoed = editDoc("Echo").replace("<p>Body.</p>", '<img src="[embedded image]" alt="x"><p>Body.</p>');
    await expect(
      updateArtifact(db, { sessionId: SESSION_ID, content: echoed, summary: "echo write" }),
    ).rejects.toThrow(/destroy the embedded images/);
  });

  it("normalizes a missing valet-design header with an explicit note", async () => {
    const result = await updateArtifact(db, {
      sessionId: SESSION_ID,
      content: "<html><head><meta charset=\"utf-8\"></head><body><h1>No Header</h1></body></html>",
      summary: "headerless write",
      template: "document",
    });
    expect(result.revision.revision).toBe("r-004");
    expect(result.notes[0]).toContain("added the missing");
    expect(result.revision.content).toContain('name="valet-design"');
    expect(result.revision.content).toContain("template=document");
  });

  it("flags an interleaved UI revision to the next agent edit, once", async () => {
    // A UI revert writes a turnId-null revision the agent never saw...
    const reverted = await revertToRevision(db, { sessionId: SESSION_ID, revision: "r-001" });
    expect(reverted.revision.revision).toBe("r-005");

    // ...so the next AGENT edit (turnId set) is told its view was stale.
    const first = await updateArtifact(db, {
      sessionId: SESSION_ID,
      content: editDoc("PostRevert"),
      summary: "agent edit after revert",
      turnId: "q-99",
    });
    expect(first.revision.revision).toBe("r-006");
    expect(first.interleaved).toEqual({ revision: "r-005", summary: "Reverted to r-001" });

    // A follow-up agent edit replaces an agent-authored revision — no flag.
    const second = await updateArtifact(db, {
      sessionId: SESSION_ID,
      content: editDoc("SecondAgentEdit"),
      summary: "consecutive agent edit",
      turnId: "q-100",
    });
    expect(second.interleaved).toBeUndefined();
  });

  it("emitDesignEvent appends a host_event the bridge maps to a design.* wire frame", async () => {
    const appended: Array<{ event: BusEvent; eventKey: string }> = [];
    const stream = {
      append: (event: BusEvent, eventKey: string) => {
        appended.push({ event, eventKey });
        return Promise.resolve({ offset: "1" });
      },
      read: () => Promise.resolve({ events: [], nextOffset: "0" }),
      subscribe: () => () => {},
      publishEphemeral: () => {},
      prune: () => Promise.resolve(0),
      deleteSession: () => Promise.resolve(),
    };
    await emitDesignEvent(stream, {
      sessionId: SESSION_ID,
      name: "design.artifact.updated",
      eventKey: "da_1:r-002",
      payload: { artifactId: "da_1", revision: "r-002", summary: "s", sizeBytes: 10 },
    });
    expect(appended).toHaveLength(1);
    expect(appended[0].eventKey).toBe("design:da_1:r-002");

    const drafts = busEventToWire({ ...appended[0].event });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      type: "design.artifact.updated",
      sessionId: SESSION_ID,
      payload: { revision: "r-002" },
    });
  });

  it("unknown host_event names are dropped by the bridge", () => {
    const drafts = busEventToWire({
      sessionId: SESSION_ID,
      event: { type: "host_event", name: "someone.else", payload: {} },
      timestamp: Date.now(),
    });
    expect(drafts).toEqual([]);
  });
});
