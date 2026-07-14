/**
 * GET /api/memory/tree — assistant-centered web UI decision 7: a flat file
 * listing (no directory rows) for the web explorer, own-scope only (unlike
 * readFile/listFiles, which read-union team scopes).
 */
import { describe, it, expect } from "vitest";
import { bootTestApi } from "./_setup.js";
import { internalToken } from "../lib/internal-auth.js";
import type { GetMemoryTreeResponse } from "../wire/types.js";

describe("GET /api/memory/tree", () => {
  it("returns a flat, sorted listing of the caller's own memory files", async () => {
    const api = await bootTestApi();
    try {
      await fetch(`${api.baseUrl}/api/memory`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "notes/b.md", content: "# B\n" }),
      });
      await fetch(`${api.baseUrl}/api/memory`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "notes/a.md", content: "# A\n", pinned: true }),
      });

      const res = await fetch(`${api.baseUrl}/api/memory/tree`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as GetMemoryTreeResponse;

      expect(body.entries.map((e) => e.path)).toEqual(["notes/a.md", "notes/b.md"]);
      const a = body.entries.find((e) => e.path === "notes/a.md");
      expect(a).toMatchObject({ title: "A", pinned: true, dir: false });
      const b = body.entries.find((e) => e.path === "notes/b.md");
      expect(b).toMatchObject({ title: "B", pinned: false, dir: false });
    } finally {
      await api.cleanup();
    }
  });

  it("does not include another owner's files even when the caller is in a shared team (own-scope only)", async () => {
    const api = await bootTestApi();
    try {
      // Write a file into a different owner's scope via the internal-token
      // path — the tree endpoint must not union it in.
      const write = await fetch(`${api.baseUrl}/api/memory`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "x-valet-internal": internalToken(),
          "x-valet-owner": "team:some-team",
          "x-valet-actor": "local-user",
        },
        body: JSON.stringify({ path: "notes/team-file.md", content: "# Team\n" }),
      });
      expect(write.status).toBe(200);

      const res = await fetch(`${api.baseUrl}/api/memory/tree`);
      const body = (await res.json()) as GetMemoryTreeResponse;
      expect(body.entries).toHaveLength(0);
    } finally {
      await api.cleanup();
    }
  });

  it("returns an empty list before any memory files exist", async () => {
    const api = await bootTestApi();
    try {
      const res = await fetch(`${api.baseUrl}/api/memory/tree`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as GetMemoryTreeResponse;
      expect(body.entries).toEqual([]);
    } finally {
      await api.cleanup();
    }
  });
});
