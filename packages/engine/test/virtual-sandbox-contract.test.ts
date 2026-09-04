import { expect, it } from "vitest";
import { runSandboxContract } from "../src/test-helpers/sandbox-contract.js";
import { omittedMarker, VirtualSandboxProvider } from "../src/index.js";

const provider = new VirtualSandboxProvider();

runSandboxContract("virtual", {
  factory: async () => {
    const sandbox = await provider.create({});
    return { sandbox, cleanup: async () => provider.destroy(sandbox.id) };
  },
  capabilities: provider.capabilities(),
  provider,
  supportsAbort: false,
  shell: "virtual",
  gatewayEndpoint: "null",
});

it("virtual exec applies zero and multibyte byte caps", async () => {
  const sandbox = await provider.create({});
  try {
    const zero = await sandbox.exec("echo x", { maxOutputBytes: 0 });
    expect(zero.stdout).toBe(omittedMarker(2));
    expect(zero.truncated).toBe(true);

    // The emoji is four UTF-8 bytes and the newline is one byte. The old
    // UTF-16 precheck saw three code units and skipped this three-byte cap.
    const multibyte = await sandbox.exec("echo 🧪", { maxOutputBytes: 3 });
    expect(multibyte.stdout).toBe(`${omittedMarker(4)}\n`);
    expect(multibyte.truncated).toBe(true);
  } finally {
    await provider.destroy(sandbox.id);
  }
});
