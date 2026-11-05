/**
 * PolicySandbox.execJob({ detached: true }) (wakeups spec B4): a detached
 * sandbox process gets uncapped output on disk and is NOT tracked as a
 * pending job, because a lease (not the run-start reconcile window) owns
 * its lifetime. See packages/engine/test/command-channel.test.ts for the
 * PolicySandbox-over-a-custom-provider construction this file follows.
 */
import { describe, expect, it } from "vitest";
import { PolicySandbox, SandboxAttachment, VirtualSandboxProvider, type SandboxProvider } from "../src/index.js";
import type { ExecJobHandle, ExecOpts, JobPoll, Sandbox } from "../src/types.js";

type FakeSandbox = Partial<Sandbox> & { id: string };

async function makePolicySandbox(raw: FakeSandbox): Promise<PolicySandbox> {
  const base = new VirtualSandboxProvider();
  const provider: SandboxProvider = {
    backend: "test",
    capabilities: () => base.capabilities(),
    create: async () => raw as Sandbox,
    restore: async () => raw as Sandbox,
    status: (id) => base.status(id),
    destroy: async () => {},
  };
  const attachment = new SandboxAttachment(provider, {});
  const policy = new PolicySandbox(attachment);
  await attachment.ensureReady({ timeoutMs: 1000 });
  return policy;
}

describe("PolicySandbox.execJob detached", () => {
  it("caps the log at 2 GiB by default and leaves pendingJobCount at zero (fix wave 2, M6)", async () => {
    const seen: ExecOpts[] = [];
    const raw: FakeSandbox = {
      id: "sb",
      execJob: async (_c, opts): Promise<ExecJobHandle> => {
        seen.push(opts ?? {});
        return { execId: "job-9" };
      },
      pollJob: async (): Promise<JobPoll> => ({ status: "running", output: "", nextOffset: 0 }),
      cancelJob: async () => {},
    };
    const policy = await makePolicySandbox(raw);
    await policy.execJob("sleep 1000", { detached: true });
    expect(seen[0]?.maxOutputBytes).toBe(2 * 1024 ** 3);
    expect(policy.pendingJobCount()).toBe(0);
  });

  it("passes a configured detached cap and the requested exec id through", async () => {
    const seen: ExecOpts[] = [];
    const raw: FakeSandbox = {
      id: "sb",
      execJob: async (_c, opts): Promise<ExecJobHandle> => {
        seen.push(opts ?? {});
        return { execId: opts?.execId ?? "job-x" };
      },
    };
    const policy = await makePolicySandbox(raw);
    await expect(policy.execJob("yes", { detached: true, maxOutputBytes: 1000, execId: "job-a-12345678" })).resolves.toEqual({
      execId: "job-a-12345678",
    });
    expect(seen[0]).toMatchObject({ maxOutputBytes: 1000, execId: "job-a-12345678" });
  });

  it("keeps the cap and the pending count for a foreground job", async () => {
    const seen: ExecOpts[] = [];
    const raw: FakeSandbox = {
      id: "sb",
      execJob: async (_c, opts): Promise<ExecJobHandle> => {
        seen.push(opts ?? {});
        return { execId: "job-1" };
      },
      pollJob: async (): Promise<JobPoll> => ({ status: "running", output: "", nextOffset: 0 }),
      cancelJob: async () => {},
    };
    const policy = await makePolicySandbox(raw);
    await policy.execJob("ls");
    expect(seen[0]?.maxOutputBytes).toBeGreaterThan(0);
    expect(policy.pendingJobCount()).toBe(1);
  });
});
