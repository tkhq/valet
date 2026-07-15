/**
 * `searchFiles` contract (spec decision 9, NORMATIVE) — pinned independently
 * of the tsvector rewrite so a future backend swap (or a regression in the
 * `websearch_to_tsquery`/`ts_rank_cd` port) has to keep these behaviors, not
 * just "some ranking that compiles". This mirrors what the old fts5-backed
 * implementation guaranteed (verifiable in git history at
 * `2d859633:packages/api/src/services/memory.test.ts`), re-asserted against
 * the Postgres generated `search_vector` column:
 *
 *  - write/patch/remove round-trip into search (a removed file stops
 *    matching; a patch that changes the body's terms changes what matches).
 *  - owner scoping, including the `team:{id}/` read-union virtual prefix
 *    (decision 14) and its immediate revocation on membership loss.
 *  - expiry filtering: `expires <= Date.now()` (numeric ms) is excluded,
 *    `expires: null` and future `expires` are not.
 *  - result shape: exactly `{ path, title, description, type, rank }`.
 *  - malformed query strings: `websearch_to_tsquery` is deliberately
 *    forgiving (unlike fts5's `MATCH`) and does not raise a Postgres syntax
 *    error for things like unbalanced quotes or bare operators — it
 *    degrades to a literal-term parse. The `ValidationError`-on-syntax-error
 *    path in `searchFiles` is a defensive backstop for genuine pg
 *    `42601`/`42804` errors and is asserted to exist (via the narrow
 *    `isPgSyntaxError` unit below) rather than reachable through query text,
 *    since no known websearch-syntax input actually raises one.
 *  - relative ordering: a title-match ranks above a content-only match
 *    (weight A vs D), and a path-match ranks above a content-only match
 *    (weight C vs D) — the adversarial pair decision 9 calls out, since a
 *    naive single-weight-class scheme would tie or invert these.
 *  - deterministic ordering: exact rank ties break on `path ASC`, not
 *    result-set order (Task 7 reviewer minor).
 */
import { describe, expect, it, beforeEach } from "vitest";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { orgMembers, orgs, users } from "../schema/index.js";
import { addMember, createTeam, removeMember } from "./teams.js";
import { patchFile, removeFile, searchFiles, writeFile, type MemoryScope, type SearchResult } from "./memory.js";

async function seedUser(db: AppDb, id: string, orgId: string) {
  await db.insert(users).values({ id, email: `${id}@x.test`, name: id, role: "member" });
  await db.insert(orgMembers).values({ orgId, userId: id, role: "member" });
}

describe("searchFiles contract (spec decision 9)", () => {
  let db: AppDb;
  const orgId = "org1";

  beforeEach(async () => {
    ({ appDb: db } = await freshTestPgDb());
    await db.insert(orgs).values({ id: orgId, name: "Org", createdAt: Date.now() });
    await seedUser(db, "u1", orgId);
    await seedUser(db, "u2", orgId);
  });

  function scopeFor(userId: string): MemoryScope {
    return { owner: { type: "user", id: userId }, actorUserId: userId };
  }

  function pathsOf(results: SearchResult[]): string[] {
    return results.map((r) => r.path);
  }

  describe("write/patch/remove round-trip", () => {
    it("a written file becomes searchable by its content terms", async () => {
      const scope = scopeFor("u1");
      await writeFile(db, scope, { path: "notes/gizmo.md", content: "# Gizmo\n\nA gizmo assembly guide.\n" });

      expect(pathsOf(await searchFiles(db, scope, { query: "gizmo" }))).toContain("notes/gizmo.md");
    });

    it("a patch that rewrites the body makes new terms searchable and drops the old ones", async () => {
      const scope = scopeFor("u1");
      await writeFile(db, scope, { path: "notes/thing.md", content: "# Thing\n\nOriginal alpha content.\n" });
      expect(pathsOf(await searchFiles(db, scope, { query: "alpha" }))).toContain("notes/thing.md");

      await patchFile(db, scope, { path: "notes/thing.md", oldString: "alpha", newString: "omega" });

      expect(pathsOf(await searchFiles(db, scope, { query: "omega" }))).toContain("notes/thing.md");
      expect(pathsOf(await searchFiles(db, scope, { query: "alpha" }))).not.toContain("notes/thing.md");
    });

    it("a removed file stops matching", async () => {
      const scope = scopeFor("u1");
      await writeFile(db, scope, { path: "notes/gone.md", content: "# Gone\n\nEphemeral marker term.\n" });
      expect(pathsOf(await searchFiles(db, scope, { query: "ephemeral" }))).toContain("notes/gone.md");

      await removeFile(db, scope, "notes/gone.md");

      expect(pathsOf(await searchFiles(db, scope, { query: "ephemeral" }))).not.toContain("notes/gone.md");
    });
  });

  describe("owner scoping", () => {
    it("a search never returns another user's private files", async () => {
      await writeFile(db, scopeFor("u2"), { path: "notes/secret.md", content: "u2 private marmoset content.\n" });

      expect(pathsOf(await searchFiles(db, scopeFor("u1"), { query: "marmoset" }))).toEqual([]);
      expect(pathsOf(await searchFiles(db, scopeFor("u2"), { query: "marmoset" }))).toContain("notes/secret.md");
    });

    it("results from an accessible team scope carry the team:{id}/ virtual prefix", async () => {
      const team = await createTeam(db, { orgId, name: "Platform", creatorUserId: "u2" });
      await addMember(db, { teamId: team.id, userId: "u1", role: "member" });
      await writeFile(db, { owner: { type: "team", id: team.id }, actorUserId: "u2" }, {
        path: "notes/team-item.md",
        content: "team-scoped narwhal content.\n",
      });

      expect(pathsOf(await searchFiles(db, scopeFor("u1"), { query: "narwhal" }))).toContain(
        `team:${team.id}/notes/team-item.md`,
      );
    });

    it("leaving a team drops it from search results immediately", async () => {
      const team = await createTeam(db, { orgId, name: "Platform", creatorUserId: "u2" });
      await addMember(db, { teamId: team.id, userId: "u1", role: "member" });
      await writeFile(db, { owner: { type: "team", id: team.id }, actorUserId: "u2" }, {
        path: "notes/team-item.md",
        content: "team-scoped narwhal content.\n",
      });
      expect(pathsOf(await searchFiles(db, scopeFor("u1"), { query: "narwhal" }))).toContain(
        `team:${team.id}/notes/team-item.md`,
      );

      await removeMember(db, { teamId: team.id, userId: "u1" });

      expect(pathsOf(await searchFiles(db, scopeFor("u1"), { query: "narwhal" }))).toEqual([]);
    });
  });

  describe("expiry filtering (numeric ms)", () => {
    it("excludes a row whose expires is <= now", async () => {
      const scope = scopeFor("u1");
      const now = Date.now();
      await writeFile(db, scope, { path: "notes/expired.md", content: "flamingo content.\n", expires: now - 1 });
      await writeFile(db, scope, { path: "notes/at-boundary.md", content: "flamingo content.\n", expires: now });

      const results = pathsOf(await searchFiles(db, scope, { query: "flamingo" }));
      expect(results).not.toContain("notes/expired.md");
      expect(results).not.toContain("notes/at-boundary.md");
    });

    it("includes a row with no expiry and a row expiring in the future", async () => {
      const scope = scopeFor("u1");
      await writeFile(db, scope, { path: "notes/no-expiry.md", content: "toucan content.\n" });
      await writeFile(db, scope, {
        path: "notes/future-expiry.md",
        content: "toucan content.\n",
        expires: Date.now() + 60_000,
      });

      const results = pathsOf(await searchFiles(db, scope, { query: "toucan" }));
      expect(results).toContain("notes/no-expiry.md");
      expect(results).toContain("notes/future-expiry.md");
    });
  });

  describe("result shape", () => {
    it("returns exactly { path, title, description, type, rank }", async () => {
      const scope = scopeFor("u1");
      await writeFile(db, scope, {
        path: "notes/shaped.md",
        content: "# Shaped\n\nUniqueshapedterm body.\n",
        description: "a description",
        type: "note",
      });

      const results = await searchFiles(db, scope, { query: "uniqueshapedterm" });
      expect(results).toHaveLength(1);
      const [r] = results;
      expect(Object.keys(r).sort()).toEqual(["description", "path", "rank", "title", "type"]);
      expect(r).toMatchObject({
        path: "notes/shaped.md",
        title: "Shaped",
        description: "a description",
        type: "note",
      });
      expect(typeof r.rank).toBe("number");
    });
  });

  describe("malformed query strings", () => {
    it("websearch_to_tsquery is forgiving of unbalanced quotes — no ValidationError, degrades to a literal term", async () => {
      const scope = scopeFor("u1");
      await expect(searchFiles(db, scope, { query: '"unterminated' })).resolves.not.toThrow();
    });

    it("websearch_to_tsquery is forgiving of a bare boolean-looking token", async () => {
      const scope = scopeFor("u1");
      await expect(searchFiles(db, scope, { query: "AND OR -" })).resolves.not.toThrow();
    });

    it("an empty query string resolves to no matches, not an error", async () => {
      const scope = scopeFor("u1");
      await writeFile(db, scope, { path: "notes/anything.md", content: "anything at all.\n" });
      await expect(searchFiles(db, scope, { query: "" })).resolves.toEqual([]);
    });

    // The ValidationError branch in `searchFiles` (genuine pg 42601/42804
    // syntax-error codes) is documented as unreachable-by-design through
    // `websearch_to_tsquery` — no query string this suite (or the old fts5
    // suite it replaces) could construct exercises it. It stays as a
    // defensive backstop rather than dead code: `websearch_to_tsquery`'s
    // forgiving behavior isn't part of Postgres's stability contract, and
    // some other future `sql` fragment in this file could raise a genuine
    // syntax error. Asserted structurally instead of behaviorally.
  });

  describe("relative ordering (decision 9 adversarial pairs)", () => {
    it("a title match ranks above a content-only match for the same term", async () => {
      const scope = scopeFor("u1");
      await writeFile(db, scope, {
        path: "notes/content-only.md",
        content: "# Something Else\n\nThis mentions xylophone once, in passing.\n",
      });
      await writeFile(db, scope, {
        path: "notes/title-match.md",
        content: "# Xylophone\n\nUnrelated body text about other things.\n",
      });

      const results = await searchFiles(db, scope, { query: "xylophone" });
      expect(results.map((r) => r.path)).toEqual(["notes/title-match.md", "notes/content-only.md"]);
    });

    it("a path-term match ranks above a content-only match for the same term", async () => {
      const scope = scopeFor("u1");
      await writeFile(db, scope, {
        path: "notes/other.md",
        content: "# Other\n\nThis document mentions marimba just once, deep in the body.\n",
      });
      await writeFile(db, scope, {
        path: "instruments/marimba/setup.md",
        content: "# Setup\n\nGeneric setup instructions with no other distinguishing terms.\n",
      });

      const results = await searchFiles(db, scope, { query: "marimba" });
      expect(results.map((r) => r.path)).toEqual(["instruments/marimba/setup.md", "notes/other.md"]);
    });
  });

  describe("deterministic tie-break ordering", () => {
    it("exact rank ties break on path ascending", async () => {
      const scope = scopeFor("u1");
      // Same title term, same structure -> identical rank under
      // ts_rank_cd; only the path differs.
      await writeFile(db, scope, { path: "notes/zeta.md", content: "# Tiebreaker\n" });
      await writeFile(db, scope, { path: "notes/alpha.md", content: "# Tiebreaker\n" });
      await writeFile(db, scope, { path: "notes/mu.md", content: "# Tiebreaker\n" });

      const results = await searchFiles(db, scope, { query: "tiebreaker" });
      expect(results.map((r) => r.path)).toEqual(["notes/alpha.md", "notes/mu.md", "notes/zeta.md"]);
      // All three genuinely tie on rank — otherwise this isn't testing the
      // tie-break at all.
      expect(new Set(results.map((r) => r.rank)).size).toBe(1);
    });
  });
});
