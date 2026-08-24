/**
 * Valet Design acceptance flows (spec §Acceptance Scenarios), API-level.
 * No LLM: the design surface's contract — session minting, revision write
 * path, revert, comments, events — is REST + internal-token traffic, which
 * is exactly what the design_* tools send. Scenario C's Google half runs
 * only against a live Slides credential and is covered by serializer unit
 * tests (gslides.test.ts) plus the fenced-transport tests here being
 * stubbed; the live round trip is deliberately out of this suite.
 *
 * Scenario A (document): create → artifact seeded → edit → revert → share
 * subset → comment lifecycle.
 * Scenario B (slides): create → sections render → targeted slide edit →
 * insert slide → anchors survive.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootTestApi, type TestApi } from "./_setup.js";
import { internalToken } from "../lib/internal-auth.js";
import { countSlides, validateDcHtml } from "@valet/plugin-design/lib";
import type { CreateSessionResponse, DesignArtifactResponse, ListSessionsResponse } from "../wire/types.js";

const INTERNAL_HEADERS = {
  "x-valet-internal": internalToken(),
  "x-valet-actor": "local-user",
  "content-type": "application/json",
};

function editedDoc(marker: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="valet-design" content="v=1; template=document"><style>h1 { color: var(--color-primary); }</style></head>
<body><h1>${marker}</h1><p>Body copy.</p></body>
</html>`;
}

describe("design acceptance (API-level)", () => {
  let api: TestApi;
  let workspaceRoot: string;

  beforeAll(async () => {
    api = await bootTestApi();
    workspaceRoot = mkdtempSync(join(tmpdir(), "valet-design-acc-"));
  });

  afterAll(async () => {
    await api.cleanup();
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  async function createDesignSession(template: string): Promise<string> {
    const res = await fetch(`${api.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace: join(workspaceRoot, template), kind: "design", template }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateSessionResponse;
    expect(body.kind).toBe("design");
    expect(body.template).toBe(template);
    return body.id;
  }

  async function getArtifact(sessionId: string): Promise<DesignArtifactResponse> {
    const res = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/design/artifact`);
    expect(res.status).toBe(200);
    return (await res.json()) as DesignArtifactResponse;
  }

  it("scenario A: document create → edit → revert → share subset → comments", async () => {
    const sessionId = await createDesignSession("document");

    // Born with a valid, addressed r-001.
    const seeded = await getArtifact(sessionId);
    expect(seeded.revision).toBe("r-001");
    expect(validateDcHtml(seeded.content).ok).toBe(true);
    expect(seeded.content).toMatch(/data-vdid="[0-9a-f_]+"/);

    // The tool seam: an internal edit writes r-002 and the update event.
    const editRes = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/design/edit`, {
      method: "POST",
      headers: INTERNAL_HEADERS,
      body: JSON.stringify({ content: editedDoc("Shorter"), summary: "Shorten the headline" }),
    });
    expect(editRes.status).toBe(200);
    expect(((await editRes.json()) as { revision: string }).revision).toBe("r-002");
    expect((await getArtifact(sessionId)).content).toContain("Shorter");

    const { events } = await api.providers.eventStream.read(sessionId);
    const updated = events.filter((e) => e.event.type === "host_event");
    expect(updated).toHaveLength(1);
    expect(updated[0].event).toMatchObject({
      type: "host_event",
      name: "design.artifact.updated",
      payload: { revision: "r-002", summary: "Shorten the headline" },
    });

    // Revert appends r-003 with r-001's content; history is intact.
    const revertRes = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/design/revert`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: "r-001" }),
    });
    expect(revertRes.status).toBe(200);
    const reverted = await getArtifact(sessionId);
    expect(reverted.revision).toBe("r-003");
    expect(reverted.content).not.toContain("Shorter");

    const revs = (await (
      await fetch(`${api.baseUrl}/api/sessions/${sessionId}/design/revisions`)
    ).json()) as { revisions: Array<{ revision: string }>; current: string };
    expect(revs.current).toBe("r-003");
    expect(revs.revisions.map((r) => r.revision)).toEqual(["r-003", "r-002", "r-001"]);

    // Share subset (threat 2): only tokens the artifact references ship.
    // The default Valet design system is always present underneath, so the
    // subset carries exactly the referenced defaults — never the full map.
    const tokens = (await (
      await fetch(`${api.baseUrl}/api/sessions/${sessionId}/design/tokens?subset=artifact`)
    ).json()) as { tokens: Record<string, string> };
    const full = (await (
      await fetch(`${api.baseUrl}/api/sessions/${sessionId}/design/tokens`)
    ).json()) as { tokens: Record<string, string> };
    expect(Object.keys(full.tokens).length).toBeGreaterThan(20); // defaults served
    expect(Object.keys(tokens.tokens).length).toBeGreaterThan(0);
    expect(Object.keys(tokens.tokens).length).toBeLessThan(Object.keys(full.tokens).length);
    for (const name of Object.keys(tokens.tokens)) {
      expect(reverted.content).toContain(`var(${name}`);
    }

    // Comment lifecycle: user posts, tool resolves.
    const vdid = /data-vdid="([0-9a-f_]+)"/.exec(reverted.content)?.[1] ?? "";
    const commentRes = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/design/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ vdid, body: "Make it shorter" }),
    });
    expect(commentRes.status).toBe(201);
    const { id: commentId } = (await commentRes.json()) as { id: string };

    const resolveRes = await fetch(
      `${api.baseUrl}/api/sessions/${sessionId}/design/comments/${commentId}/resolve`,
      { method: "POST", headers: INTERNAL_HEADERS },
    );
    expect(resolveRes.status).toBe(200);
    const comments = (await (
      await fetch(`${api.baseUrl}/api/sessions/${sessionId}/design/comments`)
    ).json()) as { comments: Array<{ id: string; resolvedAt: number | null }> };
    expect(comments.comments[0].resolvedAt).not.toBeNull();

    // The hub's list filter sees the session.
    const list = (await (
      await fetch(`${api.baseUrl}/api/sessions?kind=design`)
    ).json()) as ListSessionsResponse;
    expect(list.sessions.some((s) => s.id === sessionId)).toBe(true);
    expect(list.sessions.every((s) => s.kind === "design")).toBe(true);
  });

  it("scenario B: slides create → targeted slide edit → insert slide → anchors survive", async () => {
    const sessionId = await createDesignSession("slides");
    const seeded = await getArtifact(sessionId);
    expect(countSlides(seeded.content)).toBe(2);

    // Targeted edit of slide 2's heading — the anchor id stays put because
    // existing vdids are preserved through re-addressing.
    const h2Vdid = /<h2 data-vdid="([0-9a-f_]+)"/.exec(seeded.content)?.[1] ?? "";
    expect(h2Vdid).not.toBe("");
    const mutated = seeded.content.replace(/<h2 data-vdid="[0-9a-f_]+">[^<]*<\/h2>/, (m) =>
      m.replace(/>[^<]*</, ">Case Study<"),
    );
    const editRes = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/design/edit`, {
      method: "POST",
      headers: INTERNAL_HEADERS,
      body: JSON.stringify({ content: mutated, summary: "Slide 2 becomes a case study", parentRevision: "r-001" }),
    });
    expect(editRes.status).toBe(200);

    const afterEdit = await getArtifact(sessionId);
    expect(afterEdit.content).toContain(`<h2 data-vdid="${h2Vdid}">Case Study</h2>`);

    // Insert a slide before the last one; the existing sections' ids survive.
    const withInsert = afterEdit.content.replace(
      /<section([^>]*data-vdid="[0-9a-f_]+"[^>]*)>(\s*<h2)/,
      "<section><h2>Workflow Engine</h2><p>New slide.</p><aside>added</aside></section><section$1>$2",
    );
    const insertRes = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/design/edit`, {
      method: "POST",
      headers: INTERNAL_HEADERS,
      body: JSON.stringify({ content: withInsert, summary: "Insert workflow-engine slide" }),
    });
    expect(insertRes.status).toBe(200);

    const final = await getArtifact(sessionId);
    expect(countSlides(final.content)).toBe(3);
    expect(final.content).toContain(`<h2 data-vdid="${h2Vdid}">Case Study</h2>`);
    // The inserted section was addressed on write.
    expect(final.content).toMatch(/<section data-vdid="[0-9a-f_]+"><h2 data-vdid="[0-9a-f_]+">Workflow Engine/);

    // Stale-fence: an edit against a superseded revision is rejected with
    // a corrective message (durable-submission parentRevision fence).
    const stale = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/design/edit`, {
      method: "POST",
      headers: INTERNAL_HEADERS,
      body: JSON.stringify({ content: mutated, summary: "stale", parentRevision: "r-001" }),
    });
    expect(stale.status).toBe(400);
    expect(((await stale.json()) as { error: string }).error).toContain("Stale edit");
  });

  it("a code session has no design surface (404, existence-hiding shape)", async () => {
    const res = await fetch(`${api.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace: join(workspaceRoot, "code") }),
    });
    const body = (await res.json()) as CreateSessionResponse;
    expect(body.kind).toBe("code");
    const artifact = await fetch(`${api.baseUrl}/api/sessions/${body.id}/design/artifact`);
    expect(artifact.status).toBe(404);
  });

  it("design session create rejects a missing or unknown template with the valid list", async () => {
    const res = await fetch(`${api.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace: join(workspaceRoot, "bad"), kind: "design", template: "3d-hologram" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("Valid templates");
  });
});
