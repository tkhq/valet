/**
 * `searchFiles` contract (spec decision 9, NORMATIVE) — pinned independently
 * of the tsvector rewrite so a future backend swap (or a regression in the
 * local-query/`ts_rank_cd` implementation) has to keep these behaviors, not
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
 *  - result shape: exactly `{ path, title, description, type, rank, snippet }`.
 *  - snippet: matched body text, split into `{ text, match }` segments. The
 *    segments carry no markup — `ts_headline`'s default `<b>` markers are
 *    replaced with inert control characters and consumed here, because the
 *    client renders the snippet as React nodes and must never be handed
 *    agent-authored HTML.
 *  - local query syntax: bounded positive terms are OR alternatives, while
 *    negative terms exclude matches. Quotes preserve phrases at token
 *    boundaries. Uppercase `OR` is ignored as an optional separator. The
 *    `ValidationError`-on-syntax-error
 *    path in `searchFiles` is a defensive backstop for genuine pg
 *    `42601`/`42804` errors; it is unreachable through query text (no known
 *    websearch-syntax input raises one) and deliberately untested — the
 *    malformed-query tests below pin the forgiving behavior instead.
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
import {
  parseSnippet,
  patchFile,
  removeFile,
  searchFiles,
  writeFile,
  type MemoryScope,
  type SearchResult,
  type SearchSnippetSegment,
} from "./memory.js";

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
    it("returns exactly { path, title, description, type, rank, snippet }", async () => {
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
      expect(Object.keys(r).sort()).toEqual(["description", "path", "rank", "snippet", "title", "type"]);
      expect(r).toMatchObject({
        path: "notes/shaped.md",
        title: "Shaped",
        description: "a description",
        type: "note",
      });
      expect(typeof r.rank).toBe("number");
      expect(Array.isArray(r.snippet)).toBe(true);
    });
  });

  describe("matched-text snippet", () => {
    /** A body long enough that a leading excerpt would miss the match — the
     * whole point of the snippet is to show the line the user searched for,
     * not the first line of the file. */
    function longBody(marker: string): string {
      const filler = Array.from({ length: 40 }, (_, i) => `Routine paragraph ${i} with nothing of interest.`);
      return `# Journal\n\nOpening remarks that no reader went looking for.\n\n${filler.join("\n\n")}\n\nThe ${marker} sat on the runway all afternoon.\n\n${filler.join("\n\n")}\n`;
    }

    function snippetText(segments: SearchSnippetSegment[]): string {
      return segments.map((s) => s.text).join("");
    }

    it("excerpts the matching line from deep inside the body, not the opening line", async () => {
      const scope = scopeFor("u1");
      await writeFile(db, scope, { path: "journal/long.md", content: longBody("albatross") });

      const [r] = await searchFiles(db, scope, { query: "albatross" });
      expect(snippetText(r.snippet)).toContain("sat on the runway");
      expect(snippetText(r.snippet)).not.toContain("Opening remarks");
    });

    it("marks the matched words and only those", async () => {
      const scope = scopeFor("u1");
      await writeFile(db, scope, { path: "journal/long.md", content: longBody("albatross") });

      const [r] = await searchFiles(db, scope, { query: "albatross" });
      const matched = r.snippet.filter((s) => s.match).map((s) => s.text.toLowerCase());
      expect(matched).toEqual(["albatross"]);
      expect(r.snippet.some((s) => !s.match)).toBe(true);
    });

    it("carries no markup — a body full of HTML produces plain text segments", async () => {
      const scope = scopeFor("u1");
      await writeFile(db, scope, {
        path: "notes/markup.md",
        content: '# Markup\n\nA line with <img src=x onerror="alert(1)"> next to the pelican.\n',
      });

      const [r] = await searchFiles(db, scope, { query: "pelican" });
      const text = snippetText(r.snippet);
      expect(text).not.toContain("<");
      expect(text).not.toContain(">");
      expect(text).toContain("pelican");
    });

    it("a body that already holds the marker characters cannot fake a highlight", async () => {
      const scope = scopeFor("u1");
      // U+0002/U+0003 are what ts_headline is told to emit around a hit.
      await writeFile(db, scope, {
        path: "notes/spoof.md",
        content: "# Spoof\n\nA \u0002forged\u0003 run of words next to the ptarmigan.\n",
      });

      const [r] = await searchFiles(db, scope, { query: "ptarmigan" });
      const matched = r.snippet.filter((s) => s.match).map((s) => s.text.toLowerCase());
      expect(matched).toEqual(["ptarmigan"]);
      for (const seg of r.snippet) {
        expect(seg.text).not.toContain("\u0002");
        expect(seg.text).not.toContain("\u0003");
      }
    });

    it("collapses newlines so a snippet reads as one line", async () => {
      const scope = scopeFor("u1");
      await writeFile(db, scope, { path: "notes/wrapped.md", content: "# Wrapped\n\nline one\nwith the\nkestrel here\n" });

      const [r] = await searchFiles(db, scope, { query: "kestrel" });
      expect(snippetText(r.snippet)).not.toContain("\n");
    });

    it("excerpts the heading when the file has no body below it", async () => {
      const scope = scopeFor("u1");
      await writeFile(db, scope, { path: "notes/titled.md", content: "# Hoopoe\n" });

      const [r] = await searchFiles(db, scope, { query: "hoopoe" });
      expect(snippetText(r.snippet)).toContain("Hoopoe");
      expect(r.snippet.filter((s) => s.match).map((s) => s.text)).toEqual(["Hoopoe"]);
    });
  });

  describe("parseSnippet", () => {
    it("splits paired markers into matched segments and drops stray ones", () => {
      expect(parseSnippet("before \u0002hit\u0003 after")).toEqual([
        { text: "before ", match: false },
        { text: "hit", match: true },
        { text: " after", match: false },
      ]);
      expect(parseSnippet("stray \u0003 marker")).toEqual([{ text: "stray marker", match: false }]);
      expect(parseSnippet("unclosed \u0002hit")).toEqual([{ text: "unclosed hit", match: false }]);
    });

    it("collapses whitespace runs and trims the ends", () => {
      expect(parseSnippet("  a\n\n  b  ")).toEqual([{ text: "a b", match: false }]);
    });

    it("returns no segments for empty input", () => {
      expect(parseSnippet("")).toEqual([]);
      expect(parseSnippet("   \n  ")).toEqual([]);
    });
  });

  describe("local OR query semantics", () => {
    it("matches any unquoted whitespace-delimited term", async () => {
      const scope = scopeFor("u1");
      await writeFile(db, scope, { path: "notes/projects.md", content: "Roadmap projects live here.\n" });
      await writeFile(db, scope, { path: "notes/milestones.md", content: "Quarterly milestones live here.\n" });

      expect(pathsOf(await searchFiles(db, scope, { query: "projects milestones absent" }))).toEqual([
        "notes/milestones.md",
        "notes/projects.md",
      ]);
    });

    it("ranks a result matching more terms above single-term results", async () => {
      const scope = scopeFor("u1");
      await writeFile(db, scope, { path: "notes/one.md", content: "A project summary.\n" });
      await writeFile(db, scope, { path: "notes/two.md", content: "Project milestones summary.\n" });

      const results = await searchFiles(db, scope, { query: "project milestones" });
      expect(results.map((result) => result.path)).toEqual(["notes/two.md", "notes/one.md"]);
      expect(results[0]?.rank).toBeGreaterThan(results[1]?.rank ?? 0);
    });

    it("keeps a quoted phrase together while OR-matching unquoted terms", async () => {
      const scope = scopeFor("u1");
      await writeFile(db, scope, { path: "notes/phrase.md", content: "The release update is ready.\n" });
      await writeFile(db, scope, { path: "notes/split.md", content: "Release notes contain an update.\n" });
      await writeFile(db, scope, { path: "notes/other.md", content: "Milestones are ready.\n" });

      const paths = pathsOf(await searchFiles(db, scope, { query: '"release update" milestones' }));
      expect(paths).toContain("notes/phrase.md");
      expect(paths).toContain("notes/other.md");
      expect(paths).not.toContain("notes/split.md");
    });

    it("preserves apostrophes and recovers terms after an unmatched quote", async () => {
      const scope = scopeFor("u1");
      await writeFile(db, scope, { path: "notes/conner.md", content: "Conner's project notes.\n" });
      await writeFile(db, scope, { path: "notes/milestones.md", content: "Milestones only.\n" });

      expect(pathsOf(await searchFiles(db, scope, { query: "Conner's" }))).toContain("notes/conner.md");
      expect(pathsOf(await searchFiles(db, scope, { query: '"missing milestones' }))).toContain(
        "notes/milestones.md",
      );
    });

    it("treats uppercase OR as an optional separator", async () => {
      const scope = scopeFor("u1");
      await writeFile(db, scope, { path: "notes/project.md", content: "Project only.\n" });
      await writeFile(db, scope, { path: "notes/milestone.md", content: "Milestone only.\n" });

      expect(pathsOf(await searchFiles(db, scope, { query: "project OR milestone" }))).toEqual([
        "notes/milestone.md",
        "notes/project.md",
      ]);
      await expect(searchFiles(db, scope, { query: "OR" })).resolves.toEqual([]);
    });

    it("OR-matches positive terms before applying negative terms", async () => {
      const scope = scopeFor("u1");
      await writeFile(db, scope, { path: "notes/project.md", content: "Current project.\n" });
      await writeFile(db, scope, { path: "notes/milestone.md", content: "Current milestone.\n" });
      await writeFile(db, scope, { path: "notes/archived.md", content: "Archived project milestone.\n" });

      expect(pathsOf(await searchFiles(db, scope, { query: "project milestone -archived" }))).toEqual([
        "notes/milestone.md",
        "notes/project.md",
      ]);
    });

    it("supports negative numeric terms and makes only-negative queries empty", async () => {
      const scope = scopeFor("u1");
      await writeFile(db, scope, { path: "notes/error.md", content: "Error 12000 happened.\n" });
      await writeFile(db, scope, { path: "notes/code.md", content: "Error -32000 happened.\n" });
      await writeFile(db, scope, { path: "notes/plain-code.md", content: "Error 32000 happened.\n" });

      expect(pathsOf(await searchFiles(db, scope, { query: "error -32000" }))).toEqual([
        "notes/error.md",
      ]);
      await expect(searchFiles(db, scope, { query: "-32000" })).resolves.toEqual([]);
    });

    it("bounds long queries on the real Postgres path without throwing", async () => {
      const scope = scopeFor("u1");
      const terms = Array.from({ length: 20 }, (_, index) => `marker${index}`);
      await writeFile(db, scope, { path: "notes/first.md", content: `${terms[0]} only.\n` });
      await writeFile(db, scope, { path: "notes/late.md", content: `${terms[19]} only.\n` });

      await expect(searchFiles(db, scope, { query: terms.join(" ") })).resolves.toMatchObject([
        { path: "notes/first.md" },
      ]);
      await expect(searchFiles(db, scope, { query: "x".repeat(10_000) })).resolves.toEqual([]);
    });

    it("handles apostrophe and mid-token quote forms without one-letter phrase matches", async () => {
      const scope = scopeFor("u1");
      await writeFile(db, scope, { path: "notes/music.md", content: "Rock and roll.\n" });
      await writeFile(db, scope, { path: "notes/tis.md", content: "Tis the season.\n" });
      await writeFile(db, scope, { path: "notes/bar.md", content: "Bar only.\n" });

      expect(pathsOf(await searchFiles(db, scope, { query: "rock 'n' roll" }))).toEqual([
        "notes/music.md",
      ]);
      expect(pathsOf(await searchFiles(db, scope, { query: "'tis" }))).toEqual(["notes/tis.md"]);
      expect(pathsOf(await searchFiles(db, scope, { query: 'missing"bar' }))).toEqual(["notes/bar.md"]);
    });
  });

  describe("malformed query strings", () => {
    it("the local parser is forgiving of unbalanced quotes", async () => {
      const scope = scopeFor("u1");
      await expect(searchFiles(db, scope, { query: '"unterminated' })).resolves.not.toThrow();
    });

    it("the local parser is forgiving of bare boolean-looking tokens", async () => {
      const scope = scopeFor("u1");
      await expect(searchFiles(db, scope, { query: "AND OR -" })).resolves.not.toThrow();
    });

    it("an empty query string resolves to no matches, not an error", async () => {
      const scope = scopeFor("u1");
      await writeFile(db, scope, { path: "notes/anything.md", content: "anything at all.\n" });
      await expect(searchFiles(db, scope, { query: "" })).resolves.toEqual([]);
    });

    // The ValidationError branch catches genuine pg 42601/42804 errors.
    // The bounded query builder cannot produce those errors from text, so
    // this suite asserts malformed text through its real behavior instead.
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
