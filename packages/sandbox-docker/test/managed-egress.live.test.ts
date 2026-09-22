import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { MANAGED_EGRESS_CONTRACT_VERSION } from "@valet/engine";
import {
  applyDockerManagedEgressInfrastructure,
  buildDockerManagedEgressPlan,
  cleanupDockerManagedEgress,
  dockerManagedEgressCliRuntime,
  initializeDockerManagedEgressVolumes,
  renderHematiteConfig,
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
  httpsListenerPort: 8443,
  tunnelListenerPort: 8080,
  allowlistDomains: ["api.example.com"],
  allowlistCidrs: [],
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

  const localImageId = process.env.HEMATITE_LOCAL_IMAGE_ID;
  (localImageId ? it : it.skip)("boots exact-source Hematite by local immutable image ID", async () => {
    if (!localImageId || !/^sha256:[a-f0-9]{64}$/.test(localImageId)) throw new Error("Set HEMATITE_LOCAL_IMAGE_ID to a local sha256 image ID.");
    const certDir = await mkdtemp(join(tmpdir(), "valet-hematite-ca-"));
    const localRequest = {
      ...request,
      proxyToken: `acceptance-${"t".repeat(40)}`,
      identity: { ...request.identity, proxyId: `hematite-${suffix}` },
    };
    const original = buildDockerManagedEgressPlan(config, localRequest);
    const localPlan = {
      ...original,
      proxyArtifact: localImageId,
      proxyRunArgs: [...original.proxyRunArgs.slice(0, -1), localImageId],
    };
    const runtime = dockerManagedEgressCliRuntime();
    let callbackServer: ReturnType<typeof createServer> | undefined;
    try {
      await docker("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "1", "-subj", "/CN=ValetAcceptanceCA", "-addext", "basicConstraints=critical,CA:TRUE", "-keyout", join(certDir, "ca.key"), "-out", join(certDir, "ca.crt")]);
      await applyDockerManagedEgressInfrastructure(localPlan, runtime);
      const gatewayResult = await docker("docker", ["network", "inspect", "--format", "{{(index .IPAM.Config 0).Gateway}}", localPlan.outboundNetwork]);
      const gateway = gatewayResult.stdout.trim();
      await writeFile(join(certDir, "server.ext"), `[v3]\nsubjectAltName=IP:${gateway}\nextendedKeyUsage=serverAuth\n`);
      await docker("openssl", ["req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-subj", `/CN=${gateway}`, "-keyout", join(certDir, "server.key"), "-out", join(certDir, "server.csr")]);
      await docker("openssl", ["x509", "-req", "-days", "1", "-in", join(certDir, "server.csr"), "-CA", join(certDir, "ca.crt"), "-CAkey", join(certDir, "ca.key"), "-CAcreateserial", "-extfile", join(certDir, "server.ext"), "-extensions", "v3", "-out", join(certDir, "server.crt")]);

      let callbackBody = "";
      let callbackAuthorization = "";
      callbackServer = createServer({
        key: await readFile(join(certDir, "server.key")),
        cert: await readFile(join(certDir, "server.crt")),
      }, (incoming, response) => {
        callbackAuthorization = incoming.headers.authorization ?? "";
        incoming.setEncoding("utf8");
        incoming.on("data", (chunk: string) => { callbackBody += chunk; });
        incoming.on("end", () => {
          const parsed: unknown = JSON.parse(callbackBody);
          const requestId = typeof parsed === "object" && parsed !== null && "request_id" in parsed && typeof parsed.request_id === "string" ? parsed.request_id : "invalid";
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ version: "1", request_id: requestId, decision: "deny", decision_id: "acceptance-deny", reason_code: "unsupported_prerequisite" }));
        });
      });
      await new Promise<void>((resolve, reject) => {
        callbackServer?.once("error", reject);
        callbackServer?.listen(0, "0.0.0.0", resolve);
      });
      const address = callbackServer.address();
      if (address === null || typeof address === "string") throw new Error("Acceptance callback did not bind a TCP port.");
      const runtimeConfig = { ...config, callbackUrl: `https://${gateway}:${address.port}/v1/authorize` };
      await initializeDockerManagedEgressVolumes(localPlan, {
        token: localRequest.proxyToken,
        config: renderHematiteConfig(runtimeConfig, localRequest.identity),
        caCert: await readFile(join(certDir, "ca.crt"), "utf8"),
        caKey: await readFile(join(certDir, "ca.key"), "utf8"),
      }, runtime);
      await runtime.run(localPlan.proxyRunArgs);
      await runtime.run(localPlan.connectProxyOutboundArgs);
      await new Promise((resolve) => setTimeout(resolve, 1_000));

      const proxyIpResult = await docker("docker", ["inspect", "--format", `{{with index .NetworkSettings.Networks "${localPlan.internalNetwork}"}}{{.IPAddress}}{{end}}`, localPlan.proxyContainer]);
      await docker("docker", ["pull", "curlimages/curl:8.12.1"]);
      const proxyResponse = await docker("docker", ["run", "--rm", "--user", "0", "--network", localPlan.internalNetwork, "curlimages/curl:8.12.1", "-sS", "-x", `http://${proxyIpResult.stdout.trim()}:${config.listenerPort}`, "http://api.example.com/"]);
      const inspected = await docker("docker", ["inspect", localPlan.proxyContainer]);
      const logs = await docker("docker", ["logs", localPlan.proxyContainer]);
      expect(callbackAuthorization, `${proxyResponse.stdout}\n${logs.stdout}\n${logs.stderr}`).toBe(`Bearer ${localRequest.proxyToken}`);
      expect(callbackBody).toContain(localRequest.identity.sessionId);
      expect(callbackBody).toContain(localRequest.identity.workloadId);

      expect(inspected.stdout).not.toContain(localRequest.proxyToken);
      expect(inspected.stdout).not.toContain("PRIVATE KEY");
      expect(logs.stdout + logs.stderr).not.toContain(localRequest.proxyToken);
      expect(logs.stdout + logs.stderr).not.toContain("PRIVATE KEY");
      expect(inspected.stdout).toContain(`${config.listenerPort}/tcp`);
      expect(inspected.stdout).toContain(`${config.httpsListenerPort}/tcp`);
      expect(inspected.stdout).toContain(`${config.tunnelListenerPort}/tcp`);
      const tokenMode = await docker("docker", ["run", "--rm", "--entrypoint", "stat", "--mount", `type=volume,src=${localPlan.tokenVolume},dst=/run/valet-egress,readonly`, localImageId, "-c", "%a", "/run/valet-egress/token"]);
      expect(tokenMode.stdout.trim()).toBe("400");
    } finally {
      if (callbackServer) await new Promise<void>((resolve) => callbackServer?.close(() => resolve()));
      await cleanupDockerManagedEgress(localPlan, "missing-workload", runtime).catch(() => undefined);
      await rm(certDir, { recursive: true, force: true });
    }
  }, 120_000);
});
