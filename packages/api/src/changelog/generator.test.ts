import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  CHANGELOG_SCHEMA,
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

function add(repo: string, path: string, contents: string, subject: string, body = "") {
  const full = join(repo, path);
  writeFileSync(full, contents);
  run(repo, "add", path);
  run(repo, "commit", "-q", "-m", subject, ...(body ? ["-m", body] : []));
  return run(repo, "rev-parse", "HEAD");
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
      releasedAt: "2026-09-09T12:00:00Z",
    });

    expect(checkpoint.id).toBe(`1.2.3@${releaseSha}`);
    expect(checkpoint.previousSha).toBe(previousSha);
    expect(checkpoint.entries).toEqual([
      expect.objectContaining({
        title: "Keep the screen open",
        description: "Users no longer lose the open screen after a refresh.",
        category: "fix",
        sources: { commitSha: releaseSha, pullRequest: 12 },
        followUp: false,
      }),
    ]);
  });

  it("allows an explicit changelog marker and rejects an empty release", () => {
    expect(
      shouldIncludeCommit({
        subject: "docs: explain the new export [user-visible]",
        body: "",
        files: ["docs/export.md"],
      }),
    ).toBe(true);
    const repo = repository();
    const previousSha = add(repo, "app.ts", "one", "feat: initial feature (#1)");
    const releaseSha = add(repo, "app.test.ts", "test", "test: internal coverage (#2)");
    expect(() => generateCheckpoint({ repo, version: "1", releaseSha, previousSha })).toThrow(
      "has no user-facing entries",
    );
  });

  it("is idempotent by version and SHA and keeps newest checkpoints first", () => {
    const manifest = { schema: CHANGELOG_SCHEMA, generatedAt: "", checkpoints: [] };
    const first = {
      id: "1@aaa",
      version: "1",
      releasedAt: "2026-01-01T00:00:00Z",
      releasedSha: "aaa",
      previousSha: null,
      entries: [],
    };
    const once = upsertCheckpoint(manifest, first);
    expect(upsertCheckpoint(once, first).checkpoints).toHaveLength(1);
    expect(() => upsertCheckpoint(once, { ...first, releasedAt: "2026-01-02T00:00:00Z" })).toThrow(
      "immutable",
    );
  });
});
