import { describe, expect, it } from "vitest";
import { VirtualSandboxProvider } from "../src/index.js";

describe("Sandbox.gatewayEndpoint contract", () => {
  it("is absent on providers that don't implement it (byte-identical null path)", async () => {
    const provider = new VirtualSandboxProvider();
    const sandbox = await provider.create({ workspace: "/w" });
    expect(sandbox.gatewayEndpoint).toBeUndefined();
  });

  it("SandboxCreateOpts accepts a profile without affecting virtual create", async () => {
    const provider = new VirtualSandboxProvider();
    const headless = await provider.create({ workspace: "/a", profile: "headless" });
    const full = await provider.create({ workspace: "/b", profile: "full" });
    // virtual ignores profile; both are usable sandboxes with no gateway
    expect(headless.gatewayEndpoint).toBeUndefined();
    expect(full.gatewayEndpoint).toBeUndefined();
  });
});
