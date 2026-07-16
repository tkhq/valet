import { describe } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSandboxContract } from "@valet/engine/test-helpers";
import { DockerSandboxProvider } from "../src/index.js";
import { buildFullProfileTestImage } from "./full-profile-test-image.js";

/**
 * Memoized `docker info` probe (10s timeout), honoring VALET_SKIP_DOCKER_TESTS=1
 * as an explicit escape hatch (spec decision 11).
 */
let cached: Promise<boolean> | undefined;
function dockerAvailable(): Promise<boolean> {
  if (process.env.VALET_SKIP_DOCKER_TESTS === "1") return Promise.resolve(false);
  if (!cached) {
    cached = new Promise<boolean>((resolvePromise) => {
      const child = spawn("docker", ["info"], { stdio: "ignore" });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolvePromise(false);
      }, 10_000);
      child.on("error", () => {
        clearTimeout(timer);
        resolvePromise(false);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolvePromise(code === 0);
      });
    });
  }
  return cached;
}

const provider = new DockerSandboxProvider();
let workspace: string;
const dockerOk = await dockerAvailable();
const fullProfileImage = dockerOk ? await buildFullProfileTestImage() : "alpine:3.20";

describe.skipIf(!dockerOk)("docker sandbox contract", () => {
  runSandboxContract("docker", {
    factory: async () => {
      workspace = await mkdtemp(join(tmpdir(), "valet-docker-contract-"));
      // profile: "full" so the gatewayEndpoint case below has a mapped port
      // to observe. `fullProfileImage` carries the /bin/bash + /start-full.sh
      // that buildDockerRunArgs now requires for profile:"full" containers.
      const sandbox = await provider.create({ workspace, image: fullProfileImage, profile: "full" });
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
      const recreated = await provider.create({ workspace, image: fullProfileImage, profile: "full" });
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
    gatewayEndpoint: "mapped-port",
  });
});
