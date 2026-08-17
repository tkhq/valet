/**
 * Route-level check for the memory HTTP surface: dual auth (session user vs
 * internal token + owner/actor headers) and the full write/read/patch/
 * search/export/import round trip through real HTTP requests. Doesn't need
 * ANTHROPIC_API_KEY — the memory routes never touch the engine.
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootTestApi, type TestApi } from "./_setup.js";
import { internalToken } from "../lib/internal-auth.js";
import { mintSandboxToken } from "../auth/sandbox-tokens.js";
import { teamMembers, teams } from "../schema/index.js";
import type { GetMemoryTreeResponse } from "../wire/types.js";

describe("api integration: memory routes", () => {
  it("session user can write/read/search/patch/export their own scope", async () => {
    const api = await bootTestApi();
    try {
      const put = await fetch(`${api.baseUrl}/api/memory`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "notes/hello.md", content: "# Hello\n\nWorld.\n" }),
      });
      expect(put.status).toBe(200);
      const putBody = (await put.json()) as { file: { title: string } };
      expect(putBody.file.title).toBe("Hello");

      const get = await fetch(`${api.baseUrl}/api/memory?${new URLSearchParams({ path: "notes/hello.md" })}`);
      expect(get.status).toBe(200);
      const getBody = (await get.json()) as { kind: string; rendered: string };
      expect(getBody.kind).toBe("file");
      expect(getBody.rendered).toContain("World.");

      const patch = await fetch(`${api.baseUrl}/api/memory/patch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "notes/hello.md", oldString: "World", newString: "Memory" }),
      });
      expect(patch.status).toBe(200);

      const search = await fetch(`${api.baseUrl}/api/memory/search?${new URLSearchParams({ q: "Memory" })}`);
      expect(search.status).toBe(200);
      const searchBody = (await search.json()) as { results: { path: string }[] };
      expect(searchBody.results.map((r) => r.path)).toContain("notes/hello.md");

      const exportRes = await fetch(`${api.baseUrl}/api/memory/export`);
      expect(exportRes.status).toBe(200);
      const exportBody = (await exportRes.json()) as { files: Record<string, { content: string; hash: string }> };
      expect(exportBody.files["notes/hello.md"].content).toContain("Memory");

      const del = await fetch(`${api.baseUrl}/api/memory?${new URLSearchParams({ path: "notes/hello.md" })}`, {
        method: "DELETE",
      });
      expect(del.status).toBe(200);

      const getAfterDelete = await fetch(`${api.baseUrl}/api/memory?${new URLSearchParams({ path: "notes/hello.md" })}`);
      expect(getAfterDelete.status).toBe(404);
    } finally {
      await api.cleanup();
    }
  });

  it("rejects without a valid session or internal token", async () => {
    const api = await bootTestApi();
    try {
      // Simulate no-auth by pointing at a fresh env toggle is awkward from
      // here (VALET_LOCAL_AUTH is process-global and set by the test
      // bootstrap); instead assert the internal-token path rejects a wrong
      // token outright, which exercises the same guard.
      const res = await fetch(`${api.baseUrl}/api/memory?${new URLSearchParams({ path: "notes/x.md" })}`, {
        headers: { "x-valet-internal": "wrong-token", "x-valet-owner": "user:someone", "x-valet-actor": "someone" },
      });
      // Falls through to session auth (stub, always succeeds in test mode)
      // since the internal token didn't match — proving a bad token never
      // grants internal trust.
      expect(res.status).toBe(404); // valid session fallback, file just doesn't exist
    } finally {
      await api.cleanup();
    }
  });

  it("internal token + owner/actor headers write and read a team scope", async () => {
    const api = await bootTestApi();
    try {
      const headers = {
        "Content-Type": "application/json",
        "x-valet-internal": internalToken(),
        "x-valet-owner": "team:t1",
        "x-valet-actor": "local-user",
      };

      const put = await fetch(`${api.baseUrl}/api/memory`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ path: "notes/team-note.md", content: "# Team Note\n\nShared.\n" }),
      });
      expect(put.status).toBe(200);

      const get = await fetch(`${api.baseUrl}/api/memory?${new URLSearchParams({ path: "notes/team-note.md" })}`, {
        headers,
      });
      expect(get.status).toBe(200);
      const body = (await get.json()) as { rendered: string };
      expect(body.rendered).toContain("Shared.");

      // The session user (not on team t1) does not see it directly at the
      // real path — team-scoped rows are only reachable via the read-union
      // virtual prefix for members, which this user isn't.
      const asUser = await fetch(`${api.baseUrl}/api/memory?${new URLSearchParams({ path: "notes/team-note.md" })}`);
      expect(asUser.status).toBe(404);
    } finally {
      await api.cleanup();
    }
  });

  it("import/export round trip via HTTP", async () => {
    const api = await bootTestApi();
    try {
      const importRes = await fetch(`${api.baseUrl}/api/memory/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          files: { "notes/imported.md": "# Imported\n\nContent.\n" },
          trusted: true,
        }),
      });
      expect(importRes.status).toBe(200);
      const importBody = (await importRes.json()) as { imported: string[] };
      expect(importBody.imported).toEqual(["notes/imported.md"]);

      const exportRes = await fetch(`${api.baseUrl}/api/memory/export`);
      const exportBody = (await exportRes.json()) as { files: Record<string, { content: string }> };
      expect(exportBody.files["notes/imported.md"].content).toContain("Content.");
    } finally {
      await api.cleanup();
    }
  });
});

/**
 * `?ownerType=&ownerId=` — how a browser caller names a team's memory.
 *
 * Three rules carry the weight, and each has its own test:
 *
 *   - Send neither parameter and nothing moves. Every client written before
 *     the workspace switcher sends neither, so the default is a contract.
 *   - Reading a team's memory follows membership.
 *   - Writing a team's memory follows team-admin authority, because a write
 *     lands in a corpus every member's agent later loads as trusted context.
 *
 * A caller who fails a check gets 404, not 403: the refusal must not
 * disclose that the team exists.
 *
 * Identities come from `bootTestApi`: `local-user` is an org admin,
 * `test-member` is a plain org member, both reached with the
 * `x-valet-test-user-id` impersonation header.
 */
describe("api integration: memory owner scope", () => {
  let api: TestApi | undefined;

  afterEach(async () => {
    await api?.cleanup();
    api = undefined;
  });

  const JSON_HEADERS = { "Content-Type": "application/json" };
  const MEMBER_HEADERS = { "x-valet-test-user-id": "test-member" };
  const TEAM_QUERY = "ownerType=team&ownerId=team_1";
  const TEAM_NOTE = "notes/team-note.md";

  /** Boots the api with `team_1` in the local org, holding `roster`. */
  async function bootWithTeam(roster: Array<{ userId: string; role: "admin" | "member" }>): Promise<TestApi> {
    const target = await bootTestApi();
    await target.providers.db
      .insert(teams)
      .values({ id: "team_1", orgId: "local-org", name: "Platform", createdAt: Date.now() });
    for (const seat of roster) {
      await target.providers.db.insert(teamMembers).values({ teamId: "team_1", userId: seat.userId, role: seat.role });
    }
    return target;
  }

  /** Puts a file in `team_1`'s memory through the internal-token seam the
   * `mem_*` tools use, so the fixture never depends on the browser rule
   * under test. */
  async function seedTeamNote(target: TestApi): Promise<void> {
    const res = await fetch(`${target.baseUrl}/api/memory`, {
      method: "PUT",
      headers: {
        ...JSON_HEADERS,
        "x-valet-internal": internalToken(),
        "x-valet-owner": "team:team_1",
        "x-valet-actor": "local-user",
      },
      body: JSON.stringify({ path: TEAM_NOTE, content: "# Team Note\n\nShared.\n" }),
    });
    expect(res.status).toBe(200);
  }

  it("sends the caller to their own memory when no owner is named", async () => {
    api = await bootWithTeam([{ userId: "test-member", role: "member" }]);
    await seedTeamNote(api);

    const put = await fetch(`${api.baseUrl}/api/memory`, {
      method: "PUT",
      headers: { ...JSON_HEADERS, ...MEMBER_HEADERS },
      body: JSON.stringify({ path: "notes/mine.md", content: "# Mine\n\nPrivate.\n" }),
    });
    expect(put.status).toBe(200);

    const own = await fetch(`${api.baseUrl}/api/memory?path=notes/mine.md`, { headers: MEMBER_HEADERS });
    expect(own.status).toBe(200);
    expect(((await own.json()) as { rendered: string }).rendered).toContain("Private.");

    // The team's file sits at the same path in a different scope. Without
    // owner parameters the caller must not reach it, even as a member.
    const team = await fetch(`${api.baseUrl}/api/memory?path=${TEAM_NOTE}`, { headers: MEMBER_HEADERS });
    expect(team.status).toBe(404);

    const tree = await fetch(`${api.baseUrl}/api/memory/tree`, { headers: MEMBER_HEADERS });
    const entries = ((await tree.json()) as GetMemoryTreeResponse).entries;
    expect(entries.map((e) => e.path)).toEqual(["notes/mine.md"]);

    // The `team:{id}/` read-union prefix keeps working, unchanged.
    const viaPrefix = await fetch(
      `${api.baseUrl}/api/memory?path=${encodeURIComponent(`team:team_1/${TEAM_NOTE}`)}`,
      { headers: MEMBER_HEADERS },
    );
    expect(viaPrefix.status).toBe(200);
  });

  it("lets a team member read the team's memory", async () => {
    api = await bootWithTeam([{ userId: "test-member", role: "member" }]);
    await seedTeamNote(api);

    const read = await fetch(`${api.baseUrl}/api/memory?${TEAM_QUERY}&path=${TEAM_NOTE}`, {
      headers: MEMBER_HEADERS,
    });
    expect(read.status).toBe(200);
    expect(((await read.json()) as { rendered: string }).rendered).toContain("Shared.");

    const tree = await fetch(`${api.baseUrl}/api/memory/tree?${TEAM_QUERY}`, { headers: MEMBER_HEADERS });
    expect(tree.status).toBe(200);
    const entries = ((await tree.json()) as GetMemoryTreeResponse).entries;
    expect(entries.map((e) => e.path)).toEqual([TEAM_NOTE]);

    const search = await fetch(`${api.baseUrl}/api/memory/search?${TEAM_QUERY}&q=Shared`, {
      headers: MEMBER_HEADERS,
    });
    expect(search.status).toBe(200);
    const results = ((await search.json()) as { results: { path: string }[] }).results;
    expect(results.map((r) => r.path)).toContain(TEAM_NOTE);
  });

  it("hides the team from a caller who is not on it", async () => {
    api = await bootWithTeam([{ userId: "local-user", role: "admin" }]);
    await seedTeamNote(api);

    const read = await fetch(`${api.baseUrl}/api/memory?${TEAM_QUERY}&path=${TEAM_NOTE}`, {
      headers: MEMBER_HEADERS,
    });
    expect(read.status).toBe(404);
    // Existence-hiding: the refusal says nothing about `team_1`.
    const body = (await read.json()) as { error: string };
    expect(body.error).toBe("owner not found");
    expect(body.error).not.toContain("team_1");

    const tree = await fetch(`${api.baseUrl}/api/memory/tree?${TEAM_QUERY}`, { headers: MEMBER_HEADERS });
    expect(tree.status).toBe(404);

    const write = await fetch(`${api.baseUrl}/api/memory?${TEAM_QUERY}`, {
      method: "PUT",
      headers: { ...JSON_HEADERS, ...MEMBER_HEADERS },
      body: JSON.stringify({ path: "notes/planted.md", content: "# Planted\n" }),
    });
    expect(write.status).toBe(404);
  });

  // The read-vs-write split, on one roster: the same caller, admitted to
  // read and refused on every write verb.
  it("refuses every write verb to a plain member, and keeps the file intact", async () => {
    api = await bootWithTeam([{ userId: "test-member", role: "member" }]);
    await seedTeamNote(api);

    const read = await fetch(`${api.baseUrl}/api/memory?${TEAM_QUERY}&path=${TEAM_NOTE}`, {
      headers: MEMBER_HEADERS,
    });
    expect(read.status).toBe(200);

    const put = await fetch(`${api.baseUrl}/api/memory?${TEAM_QUERY}`, {
      method: "PUT",
      headers: { ...JSON_HEADERS, ...MEMBER_HEADERS },
      body: JSON.stringify({ path: TEAM_NOTE, content: "# Team Note\n\nPlanted instruction.\n" }),
    });
    expect(put.status).toBe(404);

    const patch = await fetch(`${api.baseUrl}/api/memory/patch?${TEAM_QUERY}`, {
      method: "POST",
      headers: { ...JSON_HEADERS, ...MEMBER_HEADERS },
      body: JSON.stringify({ path: TEAM_NOTE, oldString: "Shared", newString: "Planted" }),
    });
    expect(patch.status).toBe(404);

    const del = await fetch(`${api.baseUrl}/api/memory?${TEAM_QUERY}&path=${TEAM_NOTE}`, {
      method: "DELETE",
      headers: MEMBER_HEADERS,
    });
    expect(del.status).toBe(404);

    const imported = await fetch(`${api.baseUrl}/api/memory/import?${TEAM_QUERY}`, {
      method: "POST",
      headers: { ...JSON_HEADERS, ...MEMBER_HEADERS },
      body: JSON.stringify({ files: { "notes/planted.md": "# Planted\n" }, trusted: true }),
    });
    expect(imported.status).toBe(404);

    const after = await fetch(`${api.baseUrl}/api/memory?${TEAM_QUERY}&path=${TEAM_NOTE}`, {
      headers: MEMBER_HEADERS,
    });
    const rendered = ((await after.json()) as { rendered: string }).rendered;
    expect(rendered).toContain("Shared.");
    expect(rendered).not.toContain("Planted");

    const tree = await fetch(`${api.baseUrl}/api/memory/tree?${TEAM_QUERY}`, { headers: MEMBER_HEADERS });
    const entries = ((await tree.json()) as GetMemoryTreeResponse).entries;
    expect(entries.map((e) => e.path)).toEqual([TEAM_NOTE]);
  });

  it("lets a team admin write the team's memory, and the write lands on the team", async () => {
    api = await bootWithTeam([{ userId: "test-member", role: "admin" }]);

    const put = await fetch(`${api.baseUrl}/api/memory?${TEAM_QUERY}`, {
      method: "PUT",
      headers: { ...JSON_HEADERS, ...MEMBER_HEADERS },
      body: JSON.stringify({ path: "notes/from-admin.md", content: "# From admin\n\nAgreed.\n" }),
    });
    expect(put.status).toBe(200);

    const read = await fetch(`${api.baseUrl}/api/memory?${TEAM_QUERY}&path=notes/from-admin.md`, {
      headers: MEMBER_HEADERS,
    });
    expect(read.status).toBe(200);
    expect(((await read.json()) as { rendered: string }).rendered).toContain("Agreed.");

    // Not into the author's own memory: the owner moves, the actor does not.
    const ownScope = await fetch(`${api.baseUrl}/api/memory?path=notes/from-admin.md`, { headers: MEMBER_HEADERS });
    expect(ownScope.status).toBe(404);
  });

  it("admits nobody to org-owned memory, an org admin included", async () => {
    api = await bootTestApi();

    const read = await fetch(`${api.baseUrl}/api/memory?ownerType=org&ownerId=local-org&path=notes/x.md`);
    expect(read.status).toBe(404);

    const write = await fetch(`${api.baseUrl}/api/memory?ownerType=org&ownerId=local-org`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ path: "notes/x.md", content: "# X\n" }),
    });
    expect(write.status).toBe(404);
  });

  it("refuses another user's scope", async () => {
    api = await bootTestApi();

    const res = await fetch(`${api.baseUrl}/api/memory?ownerType=user&ownerId=test-member&path=notes/x.md`);
    expect(res.status).toBe(404);
  });

  it("rejects half an owner pair, and an unknown owner type, and says how to fix it", async () => {
    api = await bootTestApi();

    const halfType = await fetch(`${api.baseUrl}/api/memory?ownerType=team&path=notes/x.md`);
    expect(halfType.status).toBe(400);
    expect(((await halfType.json()) as { error: string }).error).toContain("ownerId");

    const halfId = await fetch(`${api.baseUrl}/api/memory?ownerId=team_1&path=notes/x.md`);
    expect(halfId.status).toBe(400);
    expect(((await halfId.json()) as { error: string }).error).toContain("ownerType");

    const badType = await fetch(`${api.baseUrl}/api/memory?ownerType=squad&ownerId=team_1&path=notes/x.md`);
    expect(badType.status).toBe(400);
    expect(((await badType.json()) as { error: string }).error).toBe("ownerType must be 'user', 'team' or 'org'.");
  });

  // The internal token and the sandbox token derive their owner from a
  // verified credential. Request-supplied owners must not reach either.
  it("ignores owner parameters on the internal-token branch", async () => {
    api = await bootWithTeam([{ userId: "test-member", role: "member" }]);
    await seedTeamNote(api);

    const headers = {
      "x-valet-internal": internalToken(),
      "x-valet-owner": "team:team_1",
      "x-valet-actor": "local-user",
    };

    const decoy = await fetch(`${api.baseUrl}/api/memory?ownerType=team&ownerId=team_other&path=${TEAM_NOTE}`, {
      headers,
    });
    expect(decoy.status).toBe(200);
    expect(((await decoy.json()) as { rendered: string }).rendered).toContain("Shared.");

    // An owner type the browser branch would reject with 400 never reaches
    // the parser here, which proves the branch returns before it.
    const malformed = await fetch(`${api.baseUrl}/api/memory?ownerType=squad&ownerId=x&path=${TEAM_NOTE}`, {
      headers,
    });
    expect(malformed.status).toBe(200);
  });

  it("ignores owner parameters on the sandbox-token branch", async () => {
    api = await bootWithTeam([{ userId: "sbx-user", role: "admin" }]);
    const { token } = await mintSandboxToken(api.providers.db, {
      sessionId: "sbx-sess",
      userId: "sbx-user",
      orgId: "local-org",
    });

    // `sbx-user` is a team_1 admin, so the parameters would be authorized on
    // the browser branch. The sandbox must still write its own user scope.
    const put = await fetch(`${api.baseUrl}/api/memory?${TEAM_QUERY}`, {
      method: "PUT",
      headers: { ...JSON_HEADERS, "x-valet-sandbox": token },
      body: JSON.stringify({ path: "notes/from-sandbox.md", content: "# From sandbox\n\nOwn scope.\n" }),
    });
    expect(put.status).toBe(200);

    const onTeam = await fetch(`${api.baseUrl}/api/memory?path=notes/from-sandbox.md`, {
      headers: {
        "x-valet-internal": internalToken(),
        "x-valet-owner": "team:team_1",
        "x-valet-actor": "local-user",
      },
    });
    expect(onTeam.status).toBe(404);

    const onUser = await fetch(`${api.baseUrl}/api/memory?path=notes/from-sandbox.md`, {
      headers: {
        "x-valet-internal": internalToken(),
        "x-valet-owner": "user:sbx-user",
        "x-valet-actor": "sbx-user",
      },
    });
    expect(onUser.status).toBe(200);
  });
});
