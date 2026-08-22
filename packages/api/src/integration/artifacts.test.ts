/**
 * Route-level checks for the artifact surface (2026-08-22 artifacts
 * design): share → public read round trip, snapshot (not live) semantics,
 * revoke + re-share token rotation, the internal-token (mem_share tool)
 * path, visibility management, and the org opt-in gate. Doesn't need
 * ANTHROPIC_API_KEY — none of these routes touch the engine.
 *
 * Anonymity is NOT exercised here: stub auth answers for every request, so
 * the anonymous branches of the access matrix are pinned by the
 * `decideArtifactAccess` unit tests in `services/artifacts.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { bootTestApi } from "./_setup.js";
import { internalToken } from "../lib/internal-auth.js";
import type {
  GetArtifactResponse,
  ListArtifactsResponse,
  ShareArtifactResponse,
} from "../wire/types.js";

async function writeMemoryFile(baseUrl: string, path: string, content: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/memory`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, content }),
  });
  expect(res.status).toBe(200);
}

async function share(baseUrl: string, path: string): Promise<ShareArtifactResponse> {
  const res = await fetch(`${baseUrl}/api/artifacts/share`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as ShareArtifactResponse;
}

/** The share URL's path part (`/a/{token}`) → API read URL. */
function readUrl(baseUrl: string, shareUrl: string): string {
  const token = new URL(shareUrl).pathname.replace(/^\/a\//, "");
  expect(token.length).toBeGreaterThanOrEqual(20); // 16 bytes base64url
  return `${baseUrl}/api/artifacts/${token}`;
}

describe("api integration: artifacts", () => {
  it("share → read round trip serves a snapshot, not the live file", async () => {
    const api = await bootTestApi();
    try {
      await writeMemoryFile(api.baseUrl, "artifacts/report.md", "# Q3 Report\n\nFirst draft.\n");
      const shared = await share(api.baseUrl, "artifacts/report.md");
      expect(shared.visibility).toBe("org");
      expect(shared.url).toContain("/a/");

      const read = await fetch(readUrl(api.baseUrl, shared.url));
      expect(read.status).toBe(200);
      expect(read.headers.get("x-robots-tag")).toBe("noindex");
      const body = (await read.json()) as GetArtifactResponse;
      expect(body.title).toBe("Q3 Report");
      expect(body.content).toContain("First draft.");
      // Stub identity is a logged-in org member → sharer attribution.
      expect(body.sharedBy).toBe("Local Dev");

      // Edit the memory file — the artifact must NOT change until re-share.
      await writeMemoryFile(api.baseUrl, "artifacts/report.md", "# Q3 Report\n\nSecond draft.\n");
      const stale = (await (await fetch(readUrl(api.baseUrl, shared.url))).json()) as GetArtifactResponse;
      expect(stale.content).toContain("First draft.");

      // Re-share publishes the update and keeps the URL stable.
      const reshared = await share(api.baseUrl, "artifacts/report.md");
      expect(reshared.url).toBe(shared.url);
      const fresh = (await (await fetch(readUrl(api.baseUrl, shared.url))).json()) as GetArtifactResponse;
      expect(fresh.content).toContain("Second draft.");
    } finally {
      await api.cleanup();
    }
  });

  it("revoke kills the link; re-share mints a NEW token", async () => {
    const api = await bootTestApi();
    try {
      await writeMemoryFile(api.baseUrl, "artifacts/plan.md", "# Plan\n\nBody.\n");
      const shared = await share(api.baseUrl, "artifacts/plan.md");

      const revoke = await fetch(`${api.baseUrl}/api/artifacts/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "artifacts/plan.md", revoke: true }),
      });
      expect(revoke.status).toBe(200);
      expect((await fetch(readUrl(api.baseUrl, shared.url))).status).toBe(404);

      // A revoked token may have leaked — reactivation must not revive it.
      const reshared = await share(api.baseUrl, "artifacts/plan.md");
      expect(reshared.url).not.toBe(shared.url);
      expect((await fetch(readUrl(api.baseUrl, shared.url))).status).toBe(404);
      expect((await fetch(readUrl(api.baseUrl, reshared.url))).status).toBe(200);
    } finally {
      await api.cleanup();
    }
  });

  it("internal token + owner/actor headers share on behalf of a session (mem_share path)", async () => {
    const api = await bootTestApi();
    try {
      const headers = {
        "Content-Type": "application/json",
        "x-valet-internal": internalToken(),
        "x-valet-owner": "user:local-user",
        "x-valet-actor": "local-user",
        "x-valet-session-id": "sess-123",
      };
      const put = await fetch(`${api.baseUrl}/api/memory`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ path: "artifacts/tool-note.md", content: "# Tool Note\n\nVia tool.\n" }),
      });
      expect(put.status).toBe(200);

      const res = await fetch(`${api.baseUrl}/api/artifacts/share`, {
        method: "POST",
        headers,
        body: JSON.stringify({ path: "artifacts/tool-note.md" }),
      });
      expect(res.status).toBe(200);
      const shared = (await res.json()) as ShareArtifactResponse;
      expect(shared.visibility).toBe("org");

      const read = await fetch(readUrl(api.baseUrl, shared.url));
      expect(read.status).toBe(200);
      expect(((await read.json()) as GetArtifactResponse).content).toContain("Via tool.");
    } finally {
      await api.cleanup();
    }
  });

  it("rejects directory paths and unshared revokes", async () => {
    const api = await bootTestApi();
    try {
      await writeMemoryFile(api.baseUrl, "artifacts/one.md", "# One\n\nBody.\n");
      const dir = await fetch(`${api.baseUrl}/api/artifacts/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "artifacts/" }),
      });
      expect(dir.status).toBe(400);

      const revoke = await fetch(`${api.baseUrl}/api/artifacts/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "artifacts/never-shared.md", revoke: true }),
      });
      expect(revoke.status).toBe(404);
    } finally {
      await api.cleanup();
    }
  });

  it("widening to public needs the org opt-in; the setting is org-admin gated", async () => {
    const api = await bootTestApi();
    try {
      await writeMemoryFile(api.baseUrl, "artifacts/memo.md", "# Memo\n\nBody.\n");
      const shared = await share(api.baseUrl, "artifacts/memo.md");

      // Opt-in off → widening 400s with the corrective action.
      const denied = await fetch(`${api.baseUrl}/api/artifacts/${shared.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visibility: "public" }),
      });
      expect(denied.status).toBe(400);
      expect(((await denied.json()) as { error: string }).error).toContain("Settings");

      // A non-admin member cannot flip the org setting.
      const memberFlip = await fetch(`${api.baseUrl}/api/org/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" },
        body: JSON.stringify({ allowPublicArtifacts: true }),
      });
      expect(memberFlip.status).toBe(403);

      // The admin can; then widening works and records the actor.
      const adminFlip = await fetch(`${api.baseUrl}/api/org/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowPublicArtifacts: true }),
      });
      expect(adminFlip.status).toBe(200);
      expect(((await adminFlip.json()) as { allowPublicArtifacts: boolean }).allowPublicArtifacts).toBe(true);

      const widened = await fetch(`${api.baseUrl}/api/artifacts/${shared.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visibility: "public" }),
      });
      expect(widened.status).toBe(200);
      expect(((await widened.json()) as { visibility: string }).visibility).toBe("public");

      // Narrowing back is allowed regardless of the setting.
      const narrowed = await fetch(`${api.baseUrl}/api/artifacts/${shared.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visibility: "org" }),
      });
      expect(narrowed.status).toBe(200);
      expect(((await narrowed.json()) as { visibility: string }).visibility).toBe("org");
    } finally {
      await api.cleanup();
    }
  });

  it("management is sharer-or-admin: another member 403s, DELETE revokes", async () => {
    const api = await bootTestApi();
    try {
      await writeMemoryFile(api.baseUrl, "artifacts/mine.md", "# Mine\n\nBody.\n");
      const shared = await share(api.baseUrl, "artifacts/mine.md");

      // `test-member` is neither the sharer nor an org admin.
      const foreign = await fetch(`${api.baseUrl}/api/artifacts/${shared.id}`, {
        method: "DELETE",
        headers: { "x-valet-test-user-id": "test-member" },
      });
      expect(foreign.status).toBe(403);

      const list = await fetch(`${api.baseUrl}/api/artifacts`);
      const listBody = (await list.json()) as ListArtifactsResponse;
      expect(listBody.artifacts.map((a) => a.path)).toContain("artifacts/mine.md");

      const del = await fetch(`${api.baseUrl}/api/artifacts/${shared.id}`, { method: "DELETE" });
      expect(del.status).toBe(200);
      expect((await fetch(readUrl(api.baseUrl, shared.url))).status).toBe(404);
    } finally {
      await api.cleanup();
    }
  });
});
