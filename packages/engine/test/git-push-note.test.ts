/**
 * `bash` after a successful `git push`: the tool reads the repository, branch
 * and head from git's report and appends the host's note for the turn.
 */
import { describe, expect, it, vi } from "vitest";
import { bashTool } from "../src/builtin-tools/index.js";
import { gitPushFacts } from "../src/builtin-tools/git-push.js";
import type { ExecResult, GitPushFacts, Sandbox, ToolContext } from "../src/types.js";

const FORCED = "To https://github.com/acme/app.git\n + 1a2b3c4...5d6e7f8 feature -> feature (forced update)\n";
const FAST_FORWARD = "To github.com:acme/app.git\n   1a2b3c4..9f8e7d6  feature -> feature\n";
const NEW_BRANCH = "To https://github.com/acme/app\n * [new branch]      feature -> feature\n";

describe("gitPushFacts", () => {
  it("reads the repository, branch and new head from git's report", () => {
    expect(gitPushFacts("git push --force-with-lease origin feature", FORCED, 0)).toEqual({ repo: "acme/app", branch: "feature", headSha: "5d6e7f8" });
    expect(gitPushFacts("cd app && git push", FAST_FORWARD, 0)).toEqual({ repo: "acme/app", branch: "feature", headSha: "9f8e7d6" });
    expect(gitPushFacts("git push -u origin feature", NEW_BRANCH, 0)).toEqual({ repo: "acme/app", branch: "feature" });
  });

  it("ignores a failed push, a push with nothing to send, and other commands", () => {
    expect(gitPushFacts("git push", FORCED, 1)).toBeUndefined();
    expect(gitPushFacts("git push", "Everything up-to-date\n", 0)).toBeUndefined();
    expect(gitPushFacts("echo git push", FORCED, 0)).toBeUndefined();
    expect(gitPushFacts("git status", FORCED, 0)).toBeUndefined();
  });
});

function ctxWith(stderr: string, exitCode: number, note?: (push: GitPushFacts) => Promise<string | undefined>): ToolContext {
  const sandbox = { id: "sb", exec: vi.fn(async (): Promise<ExecResult> => ({ stdout: "", stderr, exitCode })) };
  return {
    userId: "u1", orgId: "o1", sessionId: "s1", threadId: "t1",
    credentials: { get: async () => null, request: async () => { throw new Error("unused"); } },
    sandbox: sandbox as unknown as Sandbox,
    requestDecision: async () => { throw new Error("unused"); },
    signal: new AbortController().signal,
    threadRead: async () => [],
    listThreads: async () => [],
    setModel: async ({ model }: { model: string }) => ({ fromModel: model, toModel: model }),
    ...(note ? { gitPushNote: note } : {}),
  };
}

describe("bash tool: git push note", () => {
  it("appends the host's note to a successful push", async () => {
    const note = vi.fn(async () => "Sign these commits.");
    const result = await bashTool.execute({ command: "git push origin feature" }, ctxWith(FORCED, 0, note));
    expect(note).toHaveBeenCalledWith({ repo: "acme/app", branch: "feature", headSha: "5d6e7f8" });
    expect(result.text).toBe(`${FORCED}\n\nSign these commits.`);
  });

  it("asks for no note when the push failed or the host has none", async () => {
    const note = vi.fn(async () => "Sign these commits.");
    const failed = await bashTool.execute({ command: "git push origin feature" }, ctxWith("! [rejected]\n", 1, note));
    expect(note).not.toHaveBeenCalled();
    expect(failed.text).not.toContain("Sign");
    const quiet = await bashTool.execute({ command: "git push origin feature" }, ctxWith(FORCED, 0, async () => undefined));
    expect(quiet.text).toBe(FORCED);
  });

  it("still returns the push output when the note lookup fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await bashTool.execute({ command: "git push origin feature" }, ctxWith(FORCED, 0, async () => { throw new Error("db down"); }));
    expect(result.text).toBe(FORCED);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("git push note failed"));
    warn.mockRestore();
  });
});
