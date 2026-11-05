import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  commitsIntroducedByPullRequest,
  parseCommitMessage,
  validateCommitMessage,
} from "./commit-format.mjs";
import { shouldIncludeCommit } from "./generator.mjs";

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function repository(): string {
  const repo = mkdtempSync(join(tmpdir(), "valet-changelog-format-"));
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test User");
  return repo;
}

function commit(repo: string, file: string, subject: string, body = ""): string {
  writeFileSync(join(repo, file), `${subject}\n`);
  git(repo, "add", file);
  git(repo, "commit", "-q", "-m", subject, ...(body ? ["-m", body] : []));
  return git(repo, "rev-parse", "HEAD");
}

const sha = "0123456789abcdef";

describe("changelog commit format", () => {
  it.each([
    ["feat: add session export", "Changelog: Users can export a session."],
    ["fix(web): keep unread state", "Changelog: Changelog state stays unread until it opens."],
    ["improvement: clarify build state [user-visible]", ""],
    ["perf(api): reduce startup time", "Changelog: Valet starts faster."],
    ["security!: rotate expired credentials", "Changelog: Expired credentials now rotate."],
  ])("accepts the user-visible commit %s", (subject, body) => {
    const message = { commitSha: sha, subject, body };
    expect(validateCommitMessage(message)).toEqual([]);
    expect(parseCommitMessage(message)).toMatchObject({ ok: true, userFacing: true, metadataValid: true });
    expect(shouldIncludeCommit({ ...message, files: ["packages/api/src/app.ts"] })).toBe(true);
  });

  it.each(["build", "chore", "ci", "docs", "refactor", "test", "deps"])(
    "accepts and excludes the internal type %s",
    (type) => {
      const message = { commitSha: sha, subject: `${type}: internal maintenance`, body: "" };
      expect(validateCommitMessage(message)).toEqual([]);
      expect(parseCommitMessage(message)).toMatchObject({ ok: true, userFacing: false });
      expect(shouldIncludeCommit({ ...message, files: ["packages/api/src/app.ts"] })).toBe(false);
    },
  );

  it.each(["none", "None", "n/a", "NA", "-", "skip", "internal"])(
    "accepts %s as an opt-out and keeps the commit out of the changelog",
    (value) => {
      // Authors write "Changelog: none" to mean "this does not belong in the
      // changelog". The pipeline used to read it as the user impact and
      // publish the literal word.
      const message = { commitSha: sha, subject: "fix(slack): pin the channel name case", body: `Changelog: ${value}` };
      expect(validateCommitMessage(message)).toEqual([]);
      expect(parseCommitMessage(message)).toMatchObject({
        ok: true,
        userFacing: true,
        metadataValid: true,
        changelog: null,
        changelogOptOut: true,
      });
      expect(shouldIncludeCommit({ ...message, files: ["packages/api/src/app.ts"] })).toBe(false);
    },
  );

  it("keeps an opt-out out of the changelog even with the explicit marker", () => {
    // Two conflicting signals. The trailer is the one that speaks about the
    // changelog entry, so it decides.
    const message = {
      commitSha: sha,
      subject: "fix(slack): pin the channel name case [user-visible]",
      body: "Changelog: none",
    };
    expect(validateCommitMessage(message)).toEqual([]);
    expect(shouldIncludeCommit({ ...message, files: ["packages/api/src/app.ts"] })).toBe(false);
  });

  it("does not mistake a real impact line for an opt-out", () => {
    const message = {
      commitSha: sha,
      subject: "fix(slack): read PDFs sent over Slack",
      body: "Changelog: Valet can now read a PDF that none of the chat surfaces could open before.",
    };
    expect(validateCommitMessage(message)).toEqual([]);
    expect(parseCommitMessage(message)).toMatchObject({ changelogOptOut: false });
    expect(shouldIncludeCommit({ ...message, files: ["packages/api/src/app.ts"] })).toBe(true);
  });

  it("reports the SHA and exact subject correction for a malformed subject", () => {
    expect(validateCommitMessage({ commitSha: sha, subject: "Add export", body: "" })).toEqual([
      `${sha}: Change the subject to "<type>: <summary>" with a lowercase accepted type and a non-empty summary.`,
    ]);
    expect(validateCommitMessage({ commitSha: sha, subject: "feature: add export", body: "" })).toEqual([
      `${sha}: Change the subject type "feature" to one of: feat, fix, improvement, perf, security, build, chore, ci, docs, refactor, test, deps.`,
    ]);
  });

  it("reports the SHA and exact metadata correction for a user-facing commit", () => {
    const correction = `${sha}: Add "Changelog: <user impact>" to the commit body or add "[user-visible]" to the subject.`;
    expect(validateCommitMessage({ commitSha: sha, subject: "feat: add export", body: "" })).toEqual([
      correction,
    ]);
    expect(
      validateCommitMessage({
        commitSha: sha,
        subject: "feat: add export",
        body: "Changelog: Users can export.\nThis is not a trailer.",
      }),
    ).toEqual([correction]);
  });

  it("lets the explicit marker override an internal type", () => {
    const message = {
      commitSha: sha,
      subject: "docs: publish the user guide [user-visible]",
      body: "",
      files: ["docs/guides/export.md"],
    };
    expect(validateCommitMessage(message)).toEqual([]);
    expect(shouldIncludeCommit(message)).toBe(true);
  });

  it("uses base..head and validates only commits introduced by the pull request", () => {
    const repo = repository();
    const base = commit(repo, "base", "old unformatted history");
    git(repo, "checkout", "-q", "-b", "feature");
    const first = commit(repo, "first", "feat: first change", "Changelog: Users get the first change.");
    const second = commit(repo, "second", "test: cover the first change");

    const commits = commitsIntroducedByPullRequest({ repo, baseSha: base, headSha: second });
    expect(commits.map((item) => item.commitSha)).toEqual([first, second]);
    expect(commits.map((item) => item.subject)).toEqual([
      "feat: first change",
      "test: cover the first change",
    ]);
    expect(commits.flatMap(validateCommitMessage)).toEqual([]);
  });
});
