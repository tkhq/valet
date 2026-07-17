import { describe, it, expect } from "vitest";
import {
  VirtualSandboxProvider,
  WorkspaceProvisioningError,
  SandboxSupersededError,
  SandboxUnavailableError,
} from "../src/index.js";

describe("VirtualSandboxProvider: spec-aligned contract", () => {
  it("backend is 'virtual'", () => {
    const provider = new VirtualSandboxProvider();
    expect(provider.backend).toBe("virtual");
  });

  it("capabilities() returns the decision-1 virtual values", () => {
    const provider = new VirtualSandboxProvider();
    expect(provider.capabilities()).toEqual({
      snapshot: "none",
      persistentWorkspace: false,
      tunnels: false,
      warmPool: false,
      hibernation: false,
      coldStartEstimateMs: 0,
    });
  });

  it("status() of a live sandbox is 'ready'", async () => {
    const provider = new VirtualSandboxProvider();
    const sb = await provider.create({});
    const status = await provider.status(sb.id);
    expect(status.state).toBe("ready");
  });

  it("status() of an absent sandbox is 'released'", async () => {
    const provider = new VirtualSandboxProvider();
    const status = await provider.status("does-not-exist");
    expect(status.state).toBe("released");
  });

  it("status() of a destroyed sandbox is 'released'", async () => {
    const provider = new VirtualSandboxProvider();
    const sb = await provider.create({});
    await provider.destroy(sb.id);
    const status = await provider.status(sb.id);
    expect(status.state).toBe("released");
  });

  it("execJob/pollJob/cancelJob: inline job mode round-trips output incrementally", async () => {
    const provider = new VirtualSandboxProvider();
    const sb = await provider.create({});
    if (!sb.execJob || !sb.pollJob || !sb.cancelJob) throw new Error("job mode not implemented");

    await sb.writeFile("/note.txt", "hello job mode");
    const { execId } = await sb.execJob("cat /note.txt");

    const first = await sb.pollJob(execId, 0);
    expect(first.status).toBe("done");
    expect(first.exitCode).toBe(0);
    expect(first.output).toBe("hello job mode");

    const second = await sb.pollJob(execId, first.nextOffset);
    expect(second.output).toBe("");

    // cancelJob on an already-terminal job flips it to failed.
    await sb.cancelJob(execId);
    const third = await sb.pollJob(execId, 0);
    expect(third.status).toBe("failed");
  });

  it("pollJob on an unknown execId returns status 'failed'", async () => {
    const provider = new VirtualSandboxProvider();
    const sb = await provider.create({});
    if (!sb.pollJob) throw new Error("job mode not implemented");
    const result = await sb.pollJob("no-such-job", 0);
    expect(result.status).toBe("failed");
  });
});

describe("sandbox error classes: structured shape (decision 4)", () => {
  it("WorkspaceProvisioningError message starts with [workspace_provisioning]", () => {
    const err = new WorkspaceProvisioningError(30000);
    expect(err.message.startsWith("[workspace_provisioning]")).toBe(true);
    expect(err.code).toBe("workspace_provisioning");
    expect(err.name).toBe("WorkspaceProvisioningError");
    expect(err.timeoutMs).toBe(30000);
  });

  it("SandboxSupersededError message starts with [sandbox_superseded]", () => {
    const err = new SandboxSupersededError(2);
    expect(err.message.startsWith("[sandbox_superseded]")).toBe(true);
    expect(err.code).toBe("sandbox_superseded");
    expect(err.name).toBe("SandboxSupersededError");
  });

  it("SandboxUnavailableError message starts with [sandbox_unavailable] and preserves cause", () => {
    const cause = new Error("No such container abc");
    const err = new SandboxUnavailableError(cause);
    expect(err.message.startsWith("[sandbox_unavailable]")).toBe(true);
    expect(err.code).toBe("sandbox_unavailable");
    expect(err.name).toBe("SandboxUnavailableError");
    expect(err.cause).toBe(cause);
  });
});
