import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MANAGED_EGRESS_CONTRACT_VERSION, ManagedEgressPrerequisiteError } from "@valet/engine";
import { LocalSandboxProvider } from "../src/sandbox.js";

let workspace: string | undefined;
afterEach(async () => { if (workspace) await rm(workspace, { recursive: true, force: true }); workspace = undefined; });

describe("local managed egress", () => {
  it("advertises unsupported and rejects before sandbox creation", async () => {
    const provider = new LocalSandboxProvider(); workspace = await mkdtemp(join(tmpdir(), "valet-egress-"));
    expect(provider.capabilities().managedEgress).toMatchObject({ supported: false, ready: false });
    const pending = provider.create({ workspace, managedEgress: { requested: true, proxyToken: "t".repeat(48), identity: { orgId: "o", sessionId: "s", workloadId: "w", proxyId: "p", contractVersion: MANAGED_EGRESS_CONTRACT_VERSION } } });
    await expect(pending).rejects.toBeInstanceOf(ManagedEgressPrerequisiteError);
    await expect(provider.status("local-1")).resolves.toMatchObject({ state: "released" });
  });
});
