import { runSandboxContract } from "../src/test-helpers/sandbox-contract.js";
import { VirtualSandboxProvider } from "../src/index.js";

const provider = new VirtualSandboxProvider();

runSandboxContract("virtual", {
  factory: async () => {
    const sandbox = await provider.create({});
    return { sandbox, cleanup: async () => provider.destroy(sandbox.id) };
  },
  capabilities: provider.capabilities(),
  supportsAbort: false,
  shell: "virtual",
});
