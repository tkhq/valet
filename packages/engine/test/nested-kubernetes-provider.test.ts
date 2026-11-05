import { describe, expect, it } from "vitest";
import { SandboxAttachment } from "../src/sandbox/attachment.js";
import { VirtualSandboxProvider } from "../src/providers/sandbox/virtual.js";

describe("nested Kubernetes provider admission", () => {
  it("rejects an unsupported provider before create", async () => {
    const provider = new VirtualSandboxProvider();
    let creates = 0;
    const original = provider.create.bind(provider);
    provider.create = async (opts) => { creates += 1; return original(opts); };
    const attachment = new SandboxAttachment(provider, { nestedKubernetes: true, sessionId: "session-1" });
    await expect(attachment.ensureReady({ timeoutMs: 1_000 })).rejects.toThrow(
      "Nested Kubernetes requires the Kubernetes sandbox provider. Change the provider or remove kubernetes: true.",
    );
    expect(creates).toBe(0);
  });
});
