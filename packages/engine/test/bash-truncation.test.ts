/**
 * `bash` builtin tool: truncation markers. The sandbox layer caps output at
 * `maxOutputBytes` and reports the drop (`ExecResult.truncated`,
 * `JobPoll.truncated`); the tool must surface that drop to the model with
 * `BASH_TRUNCATION_NOTE` instead of returning silently shorter output.
 *
 * Follows the stub-ctx idiom of bash-job-mode.test.ts.
 */
import { describe, it, expect, vi } from "vitest";
import { bashTool, BASH_TRUNCATION_NOTE } from "../src/builtin-tools/index.js";
import type {
  Credential,
  CredentialProvider,
  DecisionGateRequest,
  DecisionResolution,
  ExecJobHandle,
  ExecResult,
  JobPoll,
  MessageQuery,
  Sandbox,
  SessionEntry,
  ToolContext,
} from "../src/types.js";

type FakeSandbox = Partial<Sandbox> & { id: string };

const stubCredentials: CredentialProvider = {
  get: async (): Promise<Credential | null> => null,
  request: async (): Promise<Credential> => {
    throw new Error("not implemented in test stub");
  },
};

function makeCtx(sandbox: FakeSandbox, signal: AbortSignal = new AbortController().signal): ToolContext {
  return {
    userId: "u1",
    orgId: "o1",
    sessionId: "s1",
    threadId: "t1",
    credentials: stubCredentials,
    // FakeSandbox is intentionally partial — tests only stub the methods
    // they exercise (exec/execJob/pollJob/cancelJob).
    sandbox: sandbox as Sandbox,
    requestDecision: async (_gate: DecisionGateRequest): Promise<DecisionResolution> => {
      throw new Error("not implemented in test stub");
    },
    signal,
    threadRead: async (_key: string, _opts?: MessageQuery): Promise<SessionEntry[]> => [],
    listThreads: async () => [],
    setModel: async ({ model }: { model: string }) => ({ fromModel: model, toModel: model }),
  };
}

describe("bash tool: truncation markers", () => {
  it("appends the truncation note when sync exec reports truncated", async () => {
    const sandbox: FakeSandbox = {
      id: "sb-t1",
      exec: vi.fn(
        async (): Promise<ExecResult> => ({ stdout: "head-of-output", stderr: "", exitCode: 0, truncated: true }),
      ),
    };
    const result = await bashTool.execute({ command: "yes | head -c 1M" }, makeCtx(sandbox));
    expect(result.text).toContain("head-of-output");
    expect(result.text).toContain(BASH_TRUNCATION_NOTE.trim());
  });

  it("appends the truncation note when any job poll reports truncated", async () => {
    const polls: JobPoll[] = [
      { status: "running", output: "part1 ", nextOffset: 6, truncated: true },
      { status: "done", exitCode: 0, output: "part2", nextOffset: 11 },
    ];
    const sandbox: FakeSandbox = {
      id: "sb-t2",
      execJob: vi.fn(async (): Promise<ExecJobHandle> => ({ execId: "job-1" })),
      pollJob: vi.fn(
        async (): Promise<JobPoll> => polls.shift() ?? { status: "done", exitCode: 0, output: "", nextOffset: 11 },
      ),
      cancelJob: vi.fn(async () => {}),
    };
    const result = await bashTool.execute({ command: "long", timeout: 61 }, makeCtx(sandbox));
    expect(result.text).toContain("part1 part2");
    expect(result.text).toContain(BASH_TRUNCATION_NOTE.trim());
  });

  it("does not add the note when nothing was truncated", async () => {
    const sandbox: FakeSandbox = {
      id: "sb-t3",
      exec: vi.fn(async (): Promise<ExecResult> => ({ stdout: "clean", stderr: "", exitCode: 0 })),
    };
    const result = await bashTool.execute({ command: "echo clean" }, makeCtx(sandbox));
    expect(result.text).toBe("clean");
  });
});
