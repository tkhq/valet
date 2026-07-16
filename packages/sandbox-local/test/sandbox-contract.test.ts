import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSandboxContract } from "@valet/engine/test-helpers";
import { LocalSandboxProvider } from "../src/index.js";

const provider = new LocalSandboxProvider();
let workspace: string;

runSandboxContract("local", {
  factory: async () => {
    workspace = await mkdtemp(join(tmpdir(), "valet-local-contract-"));
    const sandbox = await provider.create({ workspace });
    return {
      sandbox,
      cleanup: async () => {
        await provider.destroy(sandbox.id);
        await rm(workspace, { recursive: true, force: true });
      },
    };
  },
  recreate: async (sandbox) => {
    await provider.destroy(sandbox.id);
    const recreated = await provider.create({ workspace });
    return {
      sandbox: recreated,
      cleanup: async () => {
        await provider.destroy(recreated.id);
        await rm(workspace, { recursive: true, force: true });
      },
    };
  },
  capabilities: provider.capabilities(),
  supportsAbort: true,
  shell: "full",
  gatewayEndpoint: "null",
});
