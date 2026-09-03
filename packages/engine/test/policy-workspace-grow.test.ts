/**
 * PolicySandbox in-run workspace-full recovery (workspace-fit spec, mid-run
 * trigger) + the growWorkspace/gatewayEndpoint forwarding added with it.
 *
 * The prep-time trigger is covered in packages/api's workspace-prep tests;
 * this file pins the engine-side hook: a FAILED exec/job whose output looks
 * like ENOSPC is confirmed against `df` (both false-positive gates), grown
 * once through the raw sandbox's growWorkspace, and the agent-facing result
 * gains a note naming what happened and what to do.
 */
import { describe, it, expect, vi } from "vitest";
import {
  PolicySandbox,
  SandboxAttachment,
  type ExecResult,
  type Sandbox,
  type SandboxCapabilities,
  type SandboxCreateOpts,
  type SandboxProvider,
  type SandboxStatus,
  type WorkspaceGrowth,
} from "../src/index.js";
import { maxDfUsePercent } from "../src/sandbox/policy.js";

const OK: ExecResult = { stdout: "", stderr: "", exitCode: 0 };
const ENOSPC_FAIL: ExecResult = {
  stdout: "",
  stderr: "npm ERR! nospc ENOSPC: no space left on device, write",
  exitCode: 1,
};

const DF_FULL = `Filesystem     1024-blocks    Used Available Capacity Mounted on
/dev/nvme1n1       1038336 1038336         0     100% /workspace
Filesystem      Inodes  IUsed   IFree IUse% Mounted on
/dev/nvme1n1     65536  60000    5536      92% /workspace
`;
const DF_ROOMY = `Filesystem     1024-blocks    Used Available Capacity Mounted on
/dev/nvme1n1       1038336  435953    602383      42% /workspace
Filesystem      Inodes  IUsed   IFree IUse% Mounted on
/dev/nvme1n1     65536   9000   56536      14% /workspace
`;

/** Scripted fake raw sandbox: `df` commands answer with `dfResult`, every
 * other exec pulls from `execResults` (last one repeats). `growWorkspace` is
 * attached only via `withGrow`. */
function makeRawSandbox(opts: { execResults: ExecResult[]; dfResult?: ExecResult }) {
  const execResults = [...opts.execResults];
  const dfCalls: string[] = [];
  const sandbox: Sandbox & { dfCalls: string[]; growCalls: number } = {
    id: "raw-1",
    dfCalls,
    growCalls: 0,
    readFile: vi.fn(async () => ""),
    readBinary: vi.fn(async () => new Uint8Array()),
    writeFile: vi.fn(async () => {}),
    writeBinary: vi.fn(async () => {}),
    readdir: vi.fn(async () => [] as string[]),
    stat: vi.fn(async () => ({ isFile: true, isDirectory: false, size: 0 })),
    mkdir: vi.fn(async () => {}),
    rm: vi.fn(async () => {}),
    exec: vi.fn(async (command: string) => {
      if (command.startsWith("df ")) {
        dfCalls.push(command);
        return opts.dfResult ?? { stdout: DF_FULL, stderr: "", exitCode: 0 };
      }
      return execResults.length > 1 ? execResults.shift()! : execResults[0] ?? OK;
    }),
  };
  return sandbox;
}

function withGrow(
  sandbox: ReturnType<typeof makeRawSandbox>,
  growth: WorkspaceGrowth | Error,
): ReturnType<typeof makeRawSandbox> {
  sandbox.growWorkspace = async () => {
    sandbox.growCalls += 1;
    if (growth instanceof Error) throw growth;
    return growth;
  };
  return sandbox;
}

/** Provider that always hands back the one scripted sandbox. */
function makeProvider(sandbox: Sandbox): SandboxProvider {
  const caps: SandboxCapabilities = {
    snapshot: "none",
    persistentWorkspace: true,
    tunnels: false,
    warmPool: false,
    hibernation: false,
    customImage: false,
  };
  return {
    backend: "fake",
    capabilities: () => caps,
    create: async (_opts: SandboxCreateOpts) => sandbox,
    restore: async () => sandbox,
    destroy: async () => {},
    status: async (id: string): Promise<SandboxStatus> => ({ id, state: "ready" }),
  };
}

function makeWrapper(sandbox: Sandbox): PolicySandbox {
  const attachment = new SandboxAttachment(makeProvider(sandbox), {});
  return new PolicySandbox(attachment, { readyTimeoutMs: 1_000 });
}

describe("maxDfUsePercent", () => {
  it("returns the largest NN% token across df -P and df -Pi output", () => {
    expect(maxDfUsePercent(DF_FULL)).toBe(100);
    expect(maxDfUsePercent(DF_ROOMY)).toBe(42);
  });

  it("returns 0 when nothing parses", () => {
    expect(maxDfUsePercent("")).toBe(0);
    expect(maxDfUsePercent("df: command not found")).toBe(0);
  });
});

describe("PolicySandbox in-run ENOSPC recovery", () => {
  it("failed exec with ENOSPC output + full df + successful grow: appends the retry note", async () => {
    const raw = withGrow(makeRawSandbox({ execResults: [ENOSPC_FAIL] }), {
      grown: true,
      from: "1Gi",
      to: "2Gi",
    });
    const wrapper = makeWrapper(raw);
    const result = await wrapper.exec("pnpm install");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/\[valet\] The workspace volume was full and has been grown \(1Gi → 2Gi\)/);
    expect(result.stderr).toMatch(/Retry the command/);
    expect(raw.growCalls).toBe(1);
    expect(raw.dfCalls).toHaveLength(1);
  });

  it("ENOSPC text with a roomy df: no grow, result untouched (false-positive gate)", async () => {
    const raw = withGrow(
      makeRawSandbox({ execResults: [ENOSPC_FAIL], dfResult: { stdout: DF_ROOMY, stderr: "", exitCode: 0 } }),
      { grown: true, from: "1Gi", to: "2Gi" },
    );
    const wrapper = makeWrapper(raw);
    const result = await wrapper.exec("grep -r enospc ./fixtures");
    expect(result.stderr).toBe(ENOSPC_FAIL.stderr);
    expect(raw.growCalls).toBe(0);
  });

  it("failure without ENOSPC text: df never runs", async () => {
    const raw = withGrow(
      makeRawSandbox({ execResults: [{ stdout: "", stderr: "fatal: not a git repository", exitCode: 128 }] }),
      { grown: true },
    );
    const wrapper = makeWrapper(raw);
    await wrapper.exec("git status");
    expect(raw.dfCalls).toHaveLength(0);
    expect(raw.growCalls).toBe(0);
  });

  it("successful exec with ENOSPC text in output: untouched (exit-code gate)", async () => {
    const raw = withGrow(
      makeRawSandbox({ execResults: [{ stdout: "docs mention ENOSPC handling", stderr: "", exitCode: 0 }] }),
      { grown: true },
    );
    const wrapper = makeWrapper(raw);
    const result = await wrapper.exec("cat README.md");
    expect(result.stdout).toBe("docs mention ENOSPC handling");
    expect(raw.dfCalls).toHaveLength(0);
  });

  it("a burst of ENOSPC failures attempts one grow (in-process suppression)", async () => {
    const raw = withGrow(makeRawSandbox({ execResults: [ENOSPC_FAIL] }), {
      grown: true,
      from: "1Gi",
      to: "2Gi",
    });
    const wrapper = makeWrapper(raw);
    await wrapper.exec("pnpm install");
    await wrapper.exec("pnpm install");
    expect(raw.growCalls).toBe(1);
    expect(raw.dfCalls).toHaveLength(1);
  });

  it("raw sandbox without growWorkspace: no df probe, result untouched", async () => {
    const raw = makeRawSandbox({ execResults: [ENOSPC_FAIL] });
    const wrapper = makeWrapper(raw);
    const result = await wrapper.exec("pnpm install");
    expect(result.stderr).toBe(ENOSPC_FAIL.stderr);
    expect(raw.dfCalls).toHaveLength(0);
  });

  it("grow refused: note carries the reason and the free-space action", async () => {
    const raw = withGrow(makeRawSandbox({ execResults: [ENOSPC_FAIL] }), {
      grown: false,
      reason: "workspace is already at the 20Gi growth cap (VALET_SANDBOX_WORKSPACE_MAX).",
    });
    const wrapper = makeWrapper(raw);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await wrapper.exec("pnpm install");
    expect(result.stderr).toMatch(/20Gi growth cap/);
    expect(result.stderr).toMatch(/Free disk space in the workspace/);
    errSpy.mockRestore();
  });

  it("pending resize: note says retry shortly", async () => {
    const raw = withGrow(makeRawSandbox({ execResults: [ENOSPC_FAIL] }), {
      grown: false,
      pending: true,
      reason: "resize requested",
    });
    const wrapper = makeWrapper(raw);
    const result = await wrapper.exec("pnpm install");
    expect(result.stderr).toMatch(/should finish shortly/);
  });

  it("grow throwing never breaks the command result", async () => {
    const raw = withGrow(makeRawSandbox({ execResults: [ENOSPC_FAIL] }), new Error("pvc patch forbidden"));
    const wrapper = makeWrapper(raw);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await wrapper.exec("pnpm install");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(ENOSPC_FAIL.stderr);
    errSpy.mockRestore();
  });

  it("terminal job poll with ENOSPC output gains the note in its output", async () => {
    const raw = withGrow(makeRawSandbox({ execResults: [OK] }), { grown: true, from: "1Gi", to: "2Gi" });
    raw.execJob = vi.fn(async () => ({ execId: "job-1" }));
    raw.pollJob = vi.fn(async () => ({
      status: "done" as const,
      exitCode: 1,
      output: "write error: No space left on device",
      nextOffset: 42,
    }));
    raw.cancelJob = vi.fn(async () => {});
    const wrapper = makeWrapper(raw);
    await wrapper.execJob("pnpm install", { timeout: 120_000 });
    const poll = await wrapper.pollJob("job-1", 0);
    expect(poll.output).toMatch(/\[valet\] The workspace volume was full and has been grown/);
    expect(raw.growCalls).toBe(1);
  });
});

describe("PolicySandbox forwarding", () => {
  it("growWorkspace forwards to the raw sandbox", async () => {
    const raw = withGrow(makeRawSandbox({ execResults: [OK] }), { grown: true, from: "1Gi", to: "2Gi" });
    const wrapper = makeWrapper(raw);
    await expect(wrapper.growWorkspace()).resolves.toEqual({ grown: true, from: "1Gi", to: "2Gi" });
  });

  it("growWorkspace on a backend without the seam reports a refusal, never throws", async () => {
    const wrapper = makeWrapper(makeRawSandbox({ execResults: [OK] }));
    const result = await wrapper.growWorkspace();
    expect(result.grown).toBe(false);
    expect(result.reason).toMatch(/no growable workspace/);
  });

  it("gatewayEndpoint forwards, and absent === null (raw contract preserved)", async () => {
    const raw = makeRawSandbox({ execResults: [OK] });
    await expect(makeWrapper(raw).gatewayEndpoint()).resolves.toBeNull();
    raw.gatewayEndpoint = async () => ({ host: "svc.local", port: 9000 });
    await expect(makeWrapper(raw).gatewayEndpoint()).resolves.toEqual({ host: "svc.local", port: 9000 });
  });
});
