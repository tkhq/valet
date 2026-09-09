import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  CHANGELOG_SCHEMA,
  backfillTags,
  entryFromCommit,
  generateCheckpoint,
  shouldIncludeCommit,
  upsertCheckpoint,
} from "./generator.mjs";

function run(repo: string, ...args: string[]) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function repository() {
  const repo = mkdtempSync(join(tmpdir(), "valet-changelog-"));
  run(repo, "init", "-q");
  run(repo, "config", "user.email", "test@example.com");
  run(repo, "config", "user.name", "Test User");
  return repo;
}

function add(repo: string, path: string, contents: string, subject: string, body = "", date?: string) {
  writeFileSync(join(repo, path), contents);
  run(repo, "add", path);
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", subject, ...(body ? ["-m", body] : [])], {
    env: { ...process.env, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) },
  });
  return run(repo, "rev-parse", "HEAD");
}

function tag(repo: string, name: string, date: string) {
  execFileSync("git", ["-C", repo, "tag", "-a", name, "-m", name], {
    env: { ...process.env, GIT_COMMITTER_DATE: date },
  });
}

function emptyManifest() {
  return { schema: CHANGELOG_SCHEMA, generatedAt: new Date(0).toISOString(), checkpoints: [] };
}

describe("changelog generation", () => {
  it("uses the release range, removes internal changes, and keeps source ids", () => {
    const repo = repository();
    const previousSha = add(repo, "app.ts", "one", "feat: add the first screen (#10)");
    add(repo, "app.test.ts", "test", "test: cover the first screen (#11)");
    const releaseSha = add(
      repo,
      "app.ts",
      "two",
      "fix(web): keep the screen open (#12)",
      "User impact: Users no longer lose the open screen after a refresh.",
    );

    const checkpoint = generateCheckpoint({
      repo,
      version: "1.2.3",
      releaseSha,
      previousSha,
      releasedAt: "2026-09-09T12:00:00-07:00",
    });

    expect(checkpoint.id).toBe(`1.2.3@${releaseSha}`);
    expect(checkpoint.releasedAt).toBe("2026-09-09T19:00:00.000Z");
    expect(checkpoint.entries).toEqual([
      expect.objectContaining({
        title: "Keep the screen open",
        description: "Users no longer lose the open screen after a refresh.",
        sources: { commitSha: releaseSha, pullRequest: 12 },
        followUp: false,
      }),
    ]);
  });

  it("allows an explicit marker and records an empty release without hiding it", () => {
    expect(
      shouldIncludeCommit({
        subject: "docs: explain the new export [user-visible]",
        body: "",
        files: ["docs/export.md"],
      }),
    ).toBe(true);
    expect(shouldIncludeCommit({ subject: "rewrite cache", body: "", files: ["app.ts"] })).toBe(false);
    const repo = repository();
    const previousSha = add(repo, "app.ts", "one", "feat: initial feature (#1)");
    const releaseSha = add(repo, "app.test.ts", "test", "test: internal coverage (#2)");
    expect(
      generateCheckpoint({
        repo,
        version: "1",
        releaseSha,
        previousSha,
        releasedAt: "2026-01-01T00:00:00Z",
      }).entries,
    ).toEqual([]);
  });

  it("makes deterministic fallback copy specific to the user-facing title", () => {
    const first = entryFromCommit({
      commitSha: "a",
      authoredAt: "",
      subject: "feat: open the changelog (#1)",
      body: "",
      files: ["app.ts"],
    });
    const second = entryFromCommit({
      commitSha: "b",
      authoredAt: "",
      subject: "fix: keep the selected page open (#2)",
      body: "",
      files: ["app.ts"],
    });
    expect(first.description).toBe("Available now: Open the changelog.");
    expect(second.description).toBe("Fixed: Keep the selected page open.");
    expect(first.description).not.toBe(second.description);
    expect(first.followUp).toBe(true);
  });

  it("normalizes timestamps and orders checkpoints by instant, not offset text", () => {
    const base = {
      version: "1",
      releasedSha: "a",
      previousSha: null,
      entries: [],
    };
    const earlier = { ...base, id: "1@a", releasedAt: "2026-01-01T09:00:00+09:00" };
    const later = { ...base, id: "2@b", version: "2", releasedSha: "b", releasedAt: "2025-12-31T18:00:01-07:00" };
    const manifest = upsertCheckpoint(upsertCheckpoint(emptyManifest(), earlier), later);
    expect(manifest.checkpoints.map((item) => item.id)).toEqual(["2@b", "1@a"]);
    expect(manifest.checkpoints[0].releasedAt).toBe("2026-01-01T01:00:01.000Z");
  });

  it("rebuilds cumulative history across two successive release tags", () => {
    const repo = repository();
    add(repo, "README", "bootstrap", "chore: bootstrap", "", "2025-12-01T10:00:00+09:00");
    const firstSha = add(repo, "app.ts", "one", "feat: first release (#1)", "", "2030-01-01T10:00:00+09:00");
    tag(repo, "v1.0.0", "2026-01-01T09:00:00+09:00");
    const first = backfillTags({ repo, manifest: emptyManifest(), patterns: ["v*"] });
    expect(first.checkpoints.map((item) => item.version)).toEqual(["1.0.0"]);
    expect(first.checkpoints[0].releasedAt).toBe("2026-01-01T00:00:00.000Z");

    const secondSha = add(repo, "app.ts", "two", "fix: second release (#2)", "", "2020-01-01T10:00:00-07:00");
    tag(repo, "v1.1.0", "2025-12-31T18:00:01-07:00");
    const second = backfillTags({ repo, manifest: emptyManifest(), patterns: ["v*"] });
    expect(second.checkpoints.map((item) => item.version)).toEqual(["1.1.0", "1.0.0"]);
    expect(second.checkpoints[0]).toMatchObject({
      releasedAt: "2026-01-01T01:00:01.000Z",
      releasedSha: secondSha,
      previousSha: firstSha,
    });

    const rebuiltFromBaseline = backfillTags({ repo, manifest: first, patterns: ["v*"] });
    expect(rebuiltFromBaseline).toEqual(second);
  });

  it("is idempotent by version and SHA", () => {
    const first = {
      id: "1@aaa",
      version: "1",
      releasedAt: "2026-01-01T00:00:00Z",
      releasedSha: "aaa",
      previousSha: null,
      entries: [],
    };
    const once = upsertCheckpoint(emptyManifest(), first);
    expect(upsertCheckpoint(once, first).checkpoints).toHaveLength(1);
    expect(() => upsertCheckpoint(once, { ...first, releasedAt: "2026-01-02T00:00:00Z" })).toThrow(
      "immutable",
    );
  });
});
