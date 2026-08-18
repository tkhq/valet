/**
 * The GitHub reader behind skill sync. Drives the real reader against the
 * shared `startGithubFixture` server, so the request the reader actually
 * sends is what the assertions see — including whether an `Authorization`
 * header went out, which is the whole difference between a public read and a
 * private one.
 */
import { describe, expect, it, afterEach } from "vitest";
import {
  commitBody,
  startGithubFixture,
  treeEntry,
  type GithubFixture,
} from "../test-helpers/github-fixture.js";
import {
  GitHubSkillRepoReader,
  SkillRepoNotFoundError,
  SkillRepoReadError,
  SkillRepoTimeoutError,
} from "./skill-repo-reader.js";

let fixture: GithubFixture | undefined;

afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

function base64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

function dirEntry(name: string, type: "file" | "dir") {
  return { name, path: name, type, size: 0, sha: `sha-${name}` };
}

describe("GitHubSkillRepoReader", () => {
  it("resolves the default branch head in one unauthenticated call", async () => {
    fixture = startGithubFixture({ getCommit: () => ({ body: commitBody("commit-1") }) });
    const reader = new GitHubSkillRepoReader({ apiUrl: fixture.url });

    expect((await reader.head("tkhq/skills", "")).sha).toBe("commit-1");

    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0]?.path).toBe("/repos/tkhq/skills/commits/HEAD");
    expect(fixture.calls[0]?.authHeader).toBeUndefined();
  });

  it("resolves the head of a named ref", async () => {
    fixture = startGithubFixture({ getCommit: () => ({ body: commitBody("commit-2") }) });
    const reader = new GitHubSkillRepoReader({ apiUrl: fixture.url });

    expect((await reader.head("tkhq/skills", "release")).sha).toBe("commit-2");
    expect(fixture.calls[0]?.path).toBe("/repos/tkhq/skills/commits/release");
  });

  it("reports a server fault as a read failure, not as a missing repository", async () => {
    fixture = startGithubFixture({ getCommit: () => ({ status: 500, body: { message: "boom" } }) });
    const reader = new GitHubSkillRepoReader({ apiUrl: fixture.url });

    const err = await reader.head("tkhq/skills", "").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SkillRepoReadError);
    expect(err).not.toBeInstanceOf(SkillRepoNotFoundError);
  });

  it("gives up on a request that never answers", async () => {
    // The hang this timeout exists for: a connection that stays open and
    // sends nothing. The reader's own signal is the only thing that ends it,
    // so this fetch settles only when that signal aborts.
    const hang: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const reader = new GitHubSkillRepoReader({
      apiUrl: "https://api.github.test",
      fetchImpl: hang,
      timeoutMs: 10,
    });

    const err = await reader.head("tkhq/skills", "").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SkillRepoTimeoutError);
    expect((err as Error).message).toContain("tkhq/skills@HEAD");
    expect((err as Error).message).toContain("status page");
  });

  it("carries the commit's tree sha, so discovery costs no extra call", async () => {
    fixture = startGithubFixture({ getCommit: () => ({ body: commitBody("commit-1", "tree-9") }) });
    const reader = new GitHubSkillRepoReader({ apiUrl: fixture.url });

    expect(await reader.head("tkhq/skills", "")).toEqual({ sha: "commit-1", treeSha: "tree-9" });
    expect(fixture.calls).toHaveLength(1);
  });

  it("refuses a commit response with no tree sha", async () => {
    fixture = startGithubFixture({ getCommit: () => ({ body: { sha: "commit-1" } }) });
    const reader = new GitHubSkillRepoReader({ apiUrl: fixture.url });

    const err = await reader.head("tkhq/skills", "").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SkillRepoReadError);
    expect((err as Error).message).toContain("no tree sha");
  });

  it("reads the whole tree in one recursive call", async () => {
    fixture = startGithubFixture({
      getTree: () => ({
        body: {
          sha: "tree-9",
          truncated: false,
          tree: [
            treeEntry("04-skills", { type: "tree" }),
            treeEntry("04-skills/deploy/SKILL.md", { sha: "blob-deploy" }),
          ],
        },
      }),
    });
    const reader = new GitHubSkillRepoReader({ apiUrl: fixture.url });

    const tree = await reader.listTree("tkhq/skills", "tree-9");

    expect(tree.truncated).toBe(false);
    expect(tree.entries.map((e) => e.path)).toEqual(["04-skills", "04-skills/deploy/SKILL.md"]);
    expect(tree.entries[1]).toEqual({
      path: "04-skills/deploy/SKILL.md",
      type: "blob",
      mode: "100644",
      sha: "blob-deploy",
    });
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0]?.path).toBe("/repos/tkhq/skills/git/trees/tree-9");
    // Without this the response holds one level, which is the walk the tree
    // read exists to replace.
    expect(fixture.calls[0]?.query.recursive).toBe("1");
  });

  it("reports a cut tree rather than hiding the entries it did get", async () => {
    fixture = startGithubFixture({
      getTree: () => ({ body: { sha: "tree-9", truncated: true, tree: [treeEntry("a/SKILL.md")] } }),
    });
    const reader = new GitHubSkillRepoReader({ apiUrl: fixture.url });

    expect(await reader.listTree("tkhq/skills", "tree-9")).toMatchObject({ truncated: true });
  });

  it("lists one level of the root at a pinned commit", async () => {
    fixture = startGithubFixture({
      getContents: () => ({ body: [dirEntry("deploy", "dir"), dirEntry("README.md", "file")] }),
    });
    const reader = new GitHubSkillRepoReader({ apiUrl: fixture.url });

    const listing = await reader.listDirectory("tkhq/skills", "", "commit-1");

    expect(listing.entries.map((e) => e.name)).toEqual(["deploy", "README.md"]);
    expect(listing.complete).toBe(true);
    expect(fixture.calls[0]?.path).toBe("/repos/tkhq/skills/contents/");
    expect(fixture.calls[0]?.query.ref).toBe("commit-1");
  });

  it("lists a subdirectory", async () => {
    fixture = startGithubFixture({ getContents: () => ({ body: [dirEntry("deploy", "dir")] }) });
    const reader = new GitHubSkillRepoReader({ apiUrl: fixture.url });

    await reader.listDirectory("tkhq/skills", "agent/skills", "commit-1");

    expect(fixture.calls[0]?.path).toBe("/repos/tkhq/skills/contents/agent/skills");
  });

  it("reads a file, decodes its base64 body, and carries its blob sha", async () => {
    fixture = startGithubFixture({
      getContents: () => ({
        body: { type: "file", encoding: "base64", content: base64("# Deploy\n"), sha: "blob-1" },
      }),
    });
    const reader = new GitHubSkillRepoReader({ apiUrl: fixture.url });

    // The blob sha is what makes the two discovery paths agree: a file read
    // here and the same file's tree entry produce one manifest key.
    expect(await reader.readFile("tkhq/skills", "deploy/SKILL.md", "commit-1")).toEqual({
      text: "# Deploy\n",
      blobSha: "blob-1",
    });
  });

  it("refuses a file response with no blob sha", async () => {
    // Without a sha the manifest key would be the same for every version of
    // the file, and a changed skill would report as unchanged for ever.
    fixture = startGithubFixture({
      getContents: () => ({ body: { type: "file", encoding: "base64", content: base64("x") } }),
    });
    const reader = new GitHubSkillRepoReader({ apiUrl: fixture.url });

    const err = await reader
      .readFile("tkhq/skills", "deploy/SKILL.md", "commit-1")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SkillRepoReadError);
    expect((err as Error).message).toContain("Retry the sync");
  });

  it("returns null for a file that is not there", async () => {
    fixture = startGithubFixture({
      getContents: () => ({ status: 404, body: { message: "Not Found" } }),
    });
    const reader = new GitHubSkillRepoReader({ apiUrl: fixture.url });

    expect(await reader.readFile("tkhq/skills", "deploy/SKILL.md", "commit-1")).toBeNull();
  });

  it("returns null when the path is a directory, not a file", async () => {
    fixture = startGithubFixture({ getContents: () => ({ body: [dirEntry("a", "file")] }) });
    const reader = new GitHubSkillRepoReader({ apiUrl: fixture.url });

    expect(await reader.readFile("tkhq/skills", "deploy/SKILL.md", "commit-1")).toBeNull();
  });

  describe("with a credential", () => {
    it("reads a private repository the same request would 404 on without a token", async () => {
      // A private repository is one that answers 404 to an anonymous client
      // and 200 to an authorized one. The fixture plays exactly that, so the
      // assertion proves the header is what changes the answer rather than
      // only that the header went out.
      //
      // The fixture records each request BEFORE it calls the handler, so the
      // last recorded call is this request, and its `authHeader` is the only
      // way a handler can see what arrived.
      const authorized = (calls: { authHeader?: string }[]): boolean =>
        calls[calls.length - 1]?.authHeader === "Bearer ghu_secret";
      const f: GithubFixture = startGithubFixture({
        getCommit: () =>
          authorized(f.calls)
            ? { body: commitBody("private-commit") }
            : { status: 404, body: { message: "Not Found" } },
      });
      fixture = f;

      const anonymous = new GitHubSkillRepoReader({ apiUrl: f.url });
      await expect(anonymous.head("tkhq/tk-brain", "")).rejects.toBeInstanceOf(
        SkillRepoNotFoundError,
      );

      const withToken = new GitHubSkillRepoReader({
        apiUrl: f.url,
        credential: { kind: "user", token: "ghu_secret", ownerScope: "user", login: "octocat" },
      });
      expect((await withToken.head("tkhq/tk-brain", "")).sha).toBe("private-commit");
      expect(f.calls[1]?.authHeader).toBe("Bearer ghu_secret");
    });

    it("sends the token on directory listings and file reads too", async () => {
      fixture = startGithubFixture({
        getContents: (_owner, _repo, path) =>
          path.endsWith("SKILL.md")
            ? {
                body: {
                  type: "file",
                  encoding: "base64",
                  content: base64("# One\n"),
                  sha: "blob-one",
                },
              }
            : { body: [dirEntry("one", "dir")] },
      });
      const reader = new GitHubSkillRepoReader({
        apiUrl: fixture.url,
        credential: { kind: "installation", token: "ghs_install" },
      });

      await reader.listDirectory("tkhq/tk-brain", "", "commit-1");
      await reader.readFile("tkhq/tk-brain", "one/SKILL.md", "commit-1");

      expect(fixture.calls.map((call) => call.authHeader)).toEqual([
        "Bearer ghs_install",
        "Bearer ghs_install",
      ]);
    });

    it("keeps the token out of the 404 message", async () => {
      fixture = startGithubFixture({ getCommit: () => ({ status: 404, body: { message: "Not Found" } }) });
      const reader = new GitHubSkillRepoReader({
        apiUrl: fixture.url,
        credential: { kind: "user", token: "ghu_never_print_me", ownerScope: "user", login: "octocat" },
      });

      const err = await reader.head("tkhq/tk-brain", "").catch((e: unknown) => e);
      expect((err as Error).message).not.toContain("ghu_never_print_me");
    });

    it("does not share a header map between readers", async () => {
      // The headers used to be one module-level const. If a reader mutated
      // it, every later reader — including an anonymous one — would carry
      // somebody else's token.
      fixture = startGithubFixture({ getCommit: () => ({ body: commitBody("commit-1") }) });
      const withToken = new GitHubSkillRepoReader({
        apiUrl: fixture.url,
        credential: { kind: "user", token: "ghu_secret", ownerScope: "user" },
      });
      const anonymous = new GitHubSkillRepoReader({ apiUrl: fixture.url });

      await withToken.head("tkhq/tk-brain", "");
      await anonymous.head("tkhq/skills", "");

      expect(fixture.calls[0]?.authHeader).toBe("Bearer ghu_secret");
      expect(fixture.calls[1]?.authHeader).toBeUndefined();
    });

    it("sends no header for a tokenless credential, so a public repo still reads", async () => {
      // `none` and `unavailable` both carry no token. They change only the
      // 404 text, never whether the request goes out.
      fixture = startGithubFixture({ getCommit: () => ({ body: commitBody("commit-1") }) });

      for (const credential of [{ kind: "none" }, { kind: "unavailable" }] as const) {
        const reader = new GitHubSkillRepoReader({ apiUrl: fixture.url, credential });
        expect((await reader.head("tkhq/skills", "")).sha).toBe("commit-1");
      }

      expect(fixture.calls.map((call) => call.authHeader)).toEqual([undefined, undefined]);
    });
  });

  describe("the 404 message names which credential was used", () => {
    async function messageFor(reader: GitHubSkillRepoReader): Promise<string> {
      const err = await reader.head("tkhq/tk-brain", "").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SkillRepoNotFoundError);
      return (err as Error).message;
    }

    it("tells an unconnected reader what to connect", async () => {
      fixture = startGithubFixture({ getCommit: () => ({ status: 404, body: { message: "Not Found" } }) });

      const message = await messageFor(new GitHubSkillRepoReader({ apiUrl: fixture.url }));

      expect(message).toContain("tkhq/tk-brain");
      expect(message).toContain("no GitHub credential");
      expect(message).toContain("Connected accounts");
      expect(message).toContain("spelling mistake");
      // The advice this change exists to remove.
      expect(message).not.toContain("make the repository public");
      expect(message.toLowerCase()).not.toContain("public repositories only");
    });

    it("names the account that cannot see the repository", async () => {
      fixture = startGithubFixture({ getCommit: () => ({ status: 404, body: { message: "Not Found" } }) });

      const message = await messageFor(
        new GitHubSkillRepoReader({
          apiUrl: fixture.url,
          credential: { kind: "user", token: "ghu_secret", ownerScope: "user", login: "octocat" },
        }),
      );

      expect(message).toContain("the GitHub account octocat");
      expect(message).toContain("Get access to the repository on GitHub");
      expect(message).not.toContain("Connected accounts");
    });

    it("gives a team reader an action they can take, and names no login", async () => {
      // The reader of a team source is usually NOT the person whose
      // credential the sync uses. "Get access to the repository" does nothing
      // for them, because the sync keeps using the creator's token whatever
      // access they gain. And the login identifies one person on a row that
      // otherwise names nobody, to everyone who can see the team.
      fixture = startGithubFixture({ getCommit: () => ({ status: 404, body: { message: "Not Found" } }) });

      const message = await messageFor(
        new GitHubSkillRepoReader({
          apiUrl: fixture.url,
          credential: { kind: "user", token: "ghu_secret", ownerScope: "team", login: "octocat" },
        }),
      );

      expect(message).not.toContain("octocat");
      expect(message).toContain("the GitHub account that added this source");
      expect(message).toContain("Ask the person who added the source");
      expect(message).toContain("add the source again yourself");
    });

    it("tells a reader to reconnect when the stored credential cannot be read", async () => {
      // Distinct from `none`: a credential IS connected, so "connect GitHub"
      // would send the reader to a page that already shows an account.
      fixture = startGithubFixture({ getCommit: () => ({ status: 404, body: { message: "Not Found" } }) });

      const message = await messageFor(
        new GitHubSkillRepoReader({ apiUrl: fixture.url, credential: { kind: "unavailable" } }),
      );

      expect(message).toContain("cannot read it");
      expect(message).toContain("Connect GitHub again");
      expect(message).toContain("Connected accounts");
    });

    it("falls back to a nameless account when the login is unknown", async () => {
      fixture = startGithubFixture({ getCommit: () => ({ status: 404, body: { message: "Not Found" } }) });

      const message = await messageFor(
        new GitHubSkillRepoReader({
          apiUrl: fixture.url,
          credential: { kind: "user", token: "ghu_secret", ownerScope: "user" },
        }),
      );

      expect(message).toContain("the connected GitHub account");
    });

    it("tells an org source to widen the App installation", async () => {
      fixture = startGithubFixture({ getCommit: () => ({ status: 404, body: { message: "Not Found" } }) });

      const message = await messageFor(
        new GitHubSkillRepoReader({
          apiUrl: fixture.url,
          credential: { kind: "installation", token: "ghs_install" },
        }),
      );

      expect(message).toContain("GitHub App installed for this organization");
      expect(message).toContain("Add the repository to the App installation");
    });
  });
});
