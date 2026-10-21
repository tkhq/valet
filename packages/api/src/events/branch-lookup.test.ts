import { describe, expect, it, vi } from "vitest";
import type { Wakeup } from "@valet/engine";
import { findOpenBranchPullRequest } from "./branch-lookup.js";

const branch = "github:acme/app:branch/feat/nested";
const row: Wakeup = { id: "w", sessionId: "s", threadId: "t", kind: "event", status: "running", reason: "CI",
  createdAt: 1, updatedAt: 1, logOffset: 0, logTail: "", eventCount: 0,
  eventMatch: { clauses: [], once: true, self: [], primarySubject: branch } };
const head = { ref: "feat/nested", repo: { full_name: "acme/app" } };

describe("background branch lookup", () => {
  it("rechecks an open PR before binding", async () => {
    const read = vi.fn().mockResolvedValueOnce([{ number: 42, head }]).mockResolvedValueOnce({ state: "open", head });
    expect(await findOpenBranchPullRequest(row, read)).toEqual({ pullRequest: "github:acme/app#42", failed: false });
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls[0]?.[0]).toContain("head=acme%3Afeat%2Fnested");
  });
  it("records a merge racing the lookup instead of binding the stale PR", async () => {
    const read = vi.fn().mockResolvedValueOnce([{ number: 42, head }]).mockResolvedValueOnce({ state: "closed", head, merged: true, merge_commit_sha: "abc" });
    expect(await findOpenBranchPullRequest(row, read)).toMatchObject({ pullRequest: null, failed: false,
      closed: { branchClosed: true, status: "merged", merge_commit_sha: "abc", subjects: [branch, "github:acme/app#42"] } });
  });
  it("drops a candidate whose head no longer matches", async () => {
    const read = vi.fn().mockResolvedValueOnce([{ number: 42, head }]).mockResolvedValueOnce({ state: "open", head: { ...head, ref: "other" } });
    expect(await findOpenBranchPullRequest(row, read)).toEqual({ pullRequest: null, failed: false });
  });
  it("ignores fork heads and does not reread them", async () => {
    const read = vi.fn().mockResolvedValueOnce([{ number: 42, head: { ...head, repo: { full_name: "fork/app" } } }]);
    expect(await findOpenBranchPullRequest(row, read)).toEqual({ pullRequest: null, failed: false });
    expect(read).toHaveBeenCalledTimes(1);
  });
});
