import { describe, expect, it } from "vitest";
import { MANAGED_EGRESS_CONTRACT_VERSION } from "@valet/engine";
import {
  applyDockerManagedEgressInfrastructure,
  buildDockerManagedEgressPlan,
  cleanupDockerManagedEgress,
  type DockerManagedEgressRuntime,
  type DockerResourceKind,
} from "../src/managed-egress.js";

const request = { requested: true as const, proxyToken: "s".repeat(48), identity: { orgId: "o", sessionId: "s", workloadId: "w", proxyId: "p", contractVersion: MANAGED_EGRESS_CONTRACT_VERSION } };
const config = { proxyArtifact: `ghcr.io/tkhq/hematite@sha256:${"a".repeat(64)}`, callbackUrl: "https://valet.example/v1/authorize", listenerPort: 3128 };

class FakeRuntime implements DockerManagedEgressRuntime {
  readonly commands: Array<{ args: string[]; stdin?: string }> = [];
  readonly resources = new Map<string, Record<string, string>>();
  failWhenCreating?: string;

  key(kind: DockerResourceKind, name: string): string {
    return `${kind}:${name}`;
  }

  async inspect(kind: DockerResourceKind, name: string): Promise<Record<string, string> | null> {
    return this.resources.get(this.key(kind, name)) ?? null;
  }

  async run(args: string[], stdin?: string): Promise<void> {
    this.commands.push({ args, ...(stdin === undefined ? {} : { stdin }) });
    const name = args.at(-1);
    if (name === this.failWhenCreating && (args[1] === "create")) throw new Error("injected create failure");
    if (args[0] === "network" && args[1] === "create" && name) this.resources.set(this.key("network", name), labels(args));
    if (args[0] === "volume" && args[1] === "create" && name) this.resources.set(this.key("volume", name), labels(args));
    if (args[0] === "rm" && name) this.resources.delete(this.key("container", name));
    if (args[0] === "volume" && args[1] === "rm" && name) this.resources.delete(this.key("volume", name));
    if (args[0] === "network" && args[1] === "rm" && name) this.resources.delete(this.key("network", name));
  }
}

function labels(args: string[]): Record<string, string> {
  const found: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--label") continue;
    const [key, value] = (args[index + 1] ?? "").split("=", 2);
    if (key && value) found[key] = value;
  }
  return found;
}

describe("Docker managed egress topology", () => {
  it("keeps the workload internal and attaches only the proxy outbound", () => {
    const plan = buildDockerManagedEgressPlan(config, request);
    expect(plan.createInternalNetworkArgs).toContain("--internal");
    expect(plan.workloadNetworkArgs).toEqual(["--network", plan.internalNetwork]);
    expect(plan.connectProxyOutboundArgs).toEqual(["network", "connect", plan.outboundNetwork, plan.proxyContainer]);
    expect(plan.proxyRunArgs.join(" ")).not.toContain(request.proxyToken);
    expect(plan.proxyRunArgs.join(" ")).not.toContain("host-gateway");
    expect(plan.configVolume).not.toBe(plan.tokenVolume);
  });

  it("adopts only exact managed resources and rejects name collisions", async () => {
    const plan = buildDockerManagedEgressPlan(config, request);
    const runtime = new FakeRuntime();
    await applyDockerManagedEgressInfrastructure(plan, runtime);
    const firstCommands = [...runtime.commands];
    await applyDockerManagedEgressInfrastructure(plan, runtime);
    expect(runtime.commands).toEqual(firstCommands);

    runtime.resources.set(runtime.key("network", plan.internalNetwork), { owner: "someone-else" });
    await expect(applyDockerManagedEgressInfrastructure(plan, runtime)).rejects.toThrow(/not owned/);
  });

  it("rolls back only resources created before a partial failure", async () => {
    const plan = buildDockerManagedEgressPlan(config, request);
    const runtime = new FakeRuntime();
    runtime.failWhenCreating = plan.tokenVolume;
    await expect(applyDockerManagedEgressInfrastructure(plan, runtime)).rejects.toThrow(/injected/);
    expect(runtime.resources.size).toBe(0);
    expect(runtime.commands.slice(-2).map((entry) => entry.args)).toEqual([
      ["network", "rm", plan.outboundNetwork],
      ["network", "rm", plan.internalNetwork],
    ]);
  });

  it("disconnects first and removes only exact managed resources in order", async () => {
    const plan = buildDockerManagedEgressPlan(config, request);
    const runtime = new FakeRuntime();
    await applyDockerManagedEgressInfrastructure(plan, runtime);
    runtime.resources.set(runtime.key("container", plan.proxyContainer), plan.labels.proxy);
    runtime.commands.length = 0;

    await cleanupDockerManagedEgress(plan, "workload-container", runtime);
    expect(runtime.commands.map((entry) => entry.args)).toEqual([
      ["network", "disconnect", "-f", plan.internalNetwork, "workload-container"],
      ["rm", "-f", plan.proxyContainer],
      ["volume", "rm", "-f", plan.tokenVolume],
      ["volume", "rm", "-f", plan.configVolume],
      ["network", "rm", plan.outboundNetwork],
      ["network", "rm", plan.internalNetwork],
    ]);
    runtime.commands.length = 0;
    await cleanupDockerManagedEgress(plan, "missing-workload", runtime);
    expect(runtime.commands).toEqual([]);
  });

  it("does not remove similarly named unmanaged resources", async () => {
    const plan = buildDockerManagedEgressPlan(config, request);
    const runtime = new FakeRuntime();
    runtime.resources.set(runtime.key("network", plan.internalNetwork), { "valet.dev/managed-egress-owner": "other" });
    await expect(cleanupDockerManagedEgress(plan, "workload", runtime)).rejects.toThrow(/not owned/);
    expect(runtime.commands).toEqual([]);
  });

  it("rejects a mutable proxy artifact", () => {
    expect(() => buildDockerManagedEgressPlan({ ...config, proxyArtifact: "hematite:latest" }, request)).toThrow(/digest-pinned/);
  });
});
