import { createServer } from "node:http";
import { Exec, KubeConfig } from "@kubernetes/client-node";
import { describe, expect, it, vi } from "vitest";
import { PolicySandbox, SandboxAttachment, SandboxPreparationError, SandboxUnavailableError, VirtualSandbox } from "@valet/engine";
import { execInPod, podExecApiAdapter, PodExecTransportError } from "../src/exec.js";

describe("Kubernetes exec transport errors", () => {
  it.each([false, 0, "", {}, new Error("")])("keeps the outer message when error is %j", (error) => {
    const cause = { message: "Forbidden: exec access denied", error };
    expect(new PodExecTransportError("ns", "pod", "sandbox", cause).message).toContain(cause.message);
  });

  it.each([1900, 1950, 1970, 2000, 2030, 2048, 3000])("keeps provider codes through nested truncation at %i characters", (length) => {
    const cause = Object.assign(new Error("x".repeat(length)), { code: "EACCES" });
    const error = new SandboxPreparationError(new PodExecTransportError("ns", "pod", "sandbox", cause));
    expect(error.message).toContain("EACCES");
    expect(error.message.length).toBeLessThanOrEqual("sandbox preparation failed: ".length + 2048);
  });

  it.each([
    { cause: { error: new Error("x".repeat(3000) + " socket hang up") }, degraded: true },
    { cause: "x".repeat(3000) + " socket hang up", degraded: true },
    { cause: { error: new Error("Unexpected server response: 403") }, degraded: false },
  ])("keeps recovery classification when degraded=$degraded", async ({ cause, degraded }) => {
    const failure = new PodExecTransportError("ns", "pod", "sandbox", cause);
    const raw = new VirtualSandbox("transport-test");
    raw.exec = async () => { throw failure; };
    const attachment = SandboxAttachment.forSandbox(raw);
    try {
      const result = await new PolicySandbox(attachment).exec("test").catch((error: unknown) => error);
      if (degraded) {
        expect(result).toBeInstanceOf(SandboxUnavailableError);
        expect(attachment.state).toBe("error");
      } else {
        expect(result).toBe(failure);
        expect(attachment.state).toBe("ready");
      }
    } finally {
      await attachment.destroy();
    }
  });

  it("captures the real client-node WebSocket rejection on HTTP 403", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(403);
      response.end("Forbidden");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    // Exec transport failures must land in the api logs (stdout → Loki), not
    // only surface to the caller as a tool result — regression guard for the
    // 2026-09-15 exec-403 outage that was invisible in logs.
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a local TCP listener");
      const config = new KubeConfig();
      config.loadFromOptions({
        // The test server uses HTTP on loopback, without cluster credentials.
        clusters: [{ name: "test", server: `http://127.0.0.1:${address.port}`, skipTLSVerify: true }],
        users: [{ name: "test" }],
        contexts: [{ name: "test", cluster: "test", user: "test" }],
        currentContext: "test",
      });
      const failure = await execInPod({
        api: podExecApiAdapter(new Exec(config)), namespace: "sandboxes", containerName: "sandbox",
      }, "prep-pod", "secret command", { stdin: "secret input" }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(PodExecTransportError);
      if (!(failure instanceof PodExecTransportError)) throw new Error("Expected typed exec failure");
      expect(failure.message).toContain("Unexpected server response: 403");
      expect(failure.message).toContain("sandboxes/prep-pod (sandbox)");
      expect(failure.message).not.toContain("secret");
      expect(failure.cause).not.toBeInstanceOf(Error);
      expect(failure.cause).toMatchObject({ message: "Unexpected server response: 403", error: expect.any(Error) });
      // The failure was logged with its diagnostic message — and without the
      // command/stdin payload leaking into the log.
      expect(errorLog).toHaveBeenCalledWith("k8s pods/exec transport failed:", failure.message);
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain("secret");
    } finally {
      errorLog.mockRestore();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it.each([
    { cause: { failure: "mount denied" }, detail: '{"failure":"mount denied"}' },
    { cause: Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" }), detail: "(ECONNREFUSED) connect failed" },
    { cause: { get error(): never { throw new Error("getter failed"); }, message: "handshake failed" }, detail: "handshake failed" },
  ])("preserves $detail and its original cause", async ({ cause, detail }) => {
    const failure = await execInPod({
      api: { exec: async () => { throw cause; } }, namespace: "sandboxes", containerName: "sandbox",
    }, "prep-pod", "secret command").catch((error: unknown) => error);
    expect(failure).toMatchObject({
      name: "PodExecTransportError", code: "sandbox_exec_transport_failed", message: expect.stringContaining(detail),
    });
    if (!(failure instanceof PodExecTransportError)) throw new Error("Expected typed exec failure");
    expect(failure.cause).toBe(cause);
    expect(failure.message).not.toContain("secret");
  });
});
