import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { MANAGED_EGRESS_CONTRACT_VERSION } from "@valet/engine";
import {
  applyDockerManagedEgressInfrastructure,
  buildDockerManagedEgressPlan,
  cleanupDockerManagedEgress,
  dockerManagedEgressCliRuntime,
} from "../src/managed-egress.js";

const docker = promisify(execFile);
const live = process.env.RUN_DOCKER_LIVE === "1" ? describe : describe.skip;
const suffix = `${process.pid}-${Date.now()}`;
const request = {
  requested: true as const,
  proxyToken: "s".repeat(48),
  identity: {
    orgId: "live",
    sessionId: "live-session",
    workloadId: "live-workload",
    proxyId: `live-proxy-${suffix}`,
    contractVersion: MANAGED_EGRESS_CONTRACT_VERSION,
  },
};
const config = {
  proxyArtifact: `registry.example/hematite@sha256:${"a".repeat(64)}`,
  callbackUrl: "https://valet.example/v1/authorize",
  listenerPort: 3128,
};
const plan = buildDockerManagedEgressPlan(config, request);
const workload = `valet-egress-live-workload-${suffix}`;
const unmanaged = `${plan.internalNetwork}-unmanaged`;

async function removeBestEffort(args: string[]): Promise<void> {
  await docker("docker", args).catch(() => undefined);
}

afterAll(async () => {
  await removeBestEffort(["rm", "-f", workload, plan.proxyContainer]);
  await removeBestEffort(["network", "rm", plan.outboundNetwork, plan.internalNetwork, unmanaged]);
  await removeBestEffort(["volume", "rm", "-f", plan.tokenVolume, plan.configVolume]);
});

live("Docker managed egress live lifecycle", () => {
  it("adopts, disconnects, and leaves no managed resources", async () => {
    await docker("docker", ["pull", "alpine:3.20"]);
    const runtime = dockerManagedEgressCliRuntime();
    await applyDockerManagedEgressInfrastructure(plan, runtime);
    await applyDockerManagedEgressInfrastructure(plan, runtime);
    await docker("docker", ["network", "create", unmanaged]);
    await docker("docker", ["run", "-d", "--name", workload, "--network", plan.internalNetwork, "alpine:3.20", "sleep", "300"]);
    const proxyLabels = Object.entries(plan.labels.proxy).flatMap(([key, value]) => ["--label", `${key}=${value}`]);
    await docker("docker", ["run", "-d", "--name", plan.proxyContainer, "--network", plan.internalNetwork, ...proxyLabels, "alpine:3.20", "sleep", "300"]);
    await docker("docker", plan.connectProxyOutboundArgs);

    await cleanupDockerManagedEgress(plan, workload, runtime);
    await cleanupDockerManagedEgress(plan, "missing-workload", runtime);

    await expect(runtime.inspect("container", plan.proxyContainer)).resolves.toBeNull();
    await expect(runtime.inspect("network", plan.internalNetwork)).resolves.toBeNull();
    await expect(runtime.inspect("network", plan.outboundNetwork)).resolves.toBeNull();
    await expect(runtime.inspect("volume", plan.tokenVolume)).resolves.toBeNull();
    await expect(runtime.inspect("volume", plan.configVolume)).resolves.toBeNull();
    await expect(runtime.inspect("network", unmanaged)).resolves.toEqual({});
  }, 120_000);
});
