import { connect, type Socket } from "node:net";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MANAGED_EGRESS_CONTRACT_VERSION } from "@valet/engine";
import type { AppEnv } from "../env.js";
import type { RunningServer } from "../server-adapter.js";
import { NODE_HEADERS_TIMEOUT_MS, nodeServerAdapter } from "../server-adapter.node.js";
import { MANAGED_EGRESS_MAX_BODY_BYTES, ManagedEgressBindingRegistry, managedEgressAuthorizationRouter } from "./managed-egress-authorization.js";

const token = "t".repeat(48);
const identity = { orgId: "org-1", sessionId: "session-1", workloadId: "workload-1", proxyId: "proxy-1", contractVersion: MANAGED_EGRESS_CONTRACT_VERSION };
const body = JSON.stringify({
  version: "1", request_id: "request-1", service: "egress", action: "connect",
  subject: { session_id: "session-1", workload_id: "workload-1" },
  destination: { scheme: "https", protocol: "tcp", host: "example.com", port: 443 },
});

let server: RunningServer;
let port = 0;

function openSocket(): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port }, () => resolve(socket));
    socket.once("error", reject);
  });
}

function response(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { data += chunk; });
    socket.once("end", () => resolve(data));
    socket.once("error", reject);
  });
}

beforeEach(async () => {
  const registry = new ManagedEgressBindingRegistry();
  registry.register(identity, token);
  const app = new Hono<AppEnv>();
  app.route("", managedEgressAuthorizationRouter(registry, { bodyReadTimeoutMs: 40 }));
  const binding = nodeServerAdapter.createWebSocket(app);
  await new Promise<void>((resolve) => {
    server = binding.serve({ port: 0, onListen(bound) { port = bound; resolve(); } });
  });
});

afterEach(async () => {
  await server.close();
});

describe("managed egress raw HTTP framing", () => {
  it("cuts off a connection that dribbles incomplete headers", async () => {
    const socket = await openSocket();
    const startedAt = Date.now();
    const result = response(socket);
    socket.write(`POST /v1/authorize HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nX-Dribble: `);
    const dribble = setInterval(() => {
      if (socket.writable) socket.write("a");
    }, 100);
    try {
      const raw = await result;
      expect(raw).toContain("400 Bad Request");
      expect(Date.now() - startedAt).toBeLessThan(NODE_HEADERS_TIMEOUT_MS + 1_000);
    } finally {
      clearInterval(dribble);
      socket.destroy();
    }
  });

  it("rejects CL+TE smuggling with privacy headers", async () => {
    const socket = await openSocket();
    const result = response(socket);
    socket.end([
      "POST /v1/authorize HTTP/1.1", `Host: 127.0.0.1:${port}`,
      `Authorization: Bearer ${token}`, "Content-Type: application/json",
      `Content-Length: ${Buffer.byteLength(body)}`, "Transfer-Encoding: chunked", "Connection: close", "", body,
    ].join("\r\n"));
    const raw = await result;
    expect(raw).toContain("400 Bad Request");
    expect(raw.toLowerCase()).toContain("cache-control: no-store");
  });

  it("stops a chunked 200 MB-style sender after bounded bytes", async () => {
    const rssBefore = process.memoryUsage().rss;
    const socket = await openSocket();
    const result = response(socket);
    let responded = false;
    void result.then(() => { responded = true; });
    socket.write([
      "POST /v1/authorize HTTP/1.1", `Host: 127.0.0.1:${port}`,
      `Authorization: Bearer ${token}`, "Content-Type: application/json",
      "Transfer-Encoding: chunked", "Connection: close", "", "",
    ].join("\r\n"));
    const chunk = `${(1024).toString(16)}\r\n${"x".repeat(1024)}\r\n`;
    let sent = 0;
    while (sent < 200 * 1024 * 1024 && !socket.destroyed && !responded) {
      sent += 1024;
      if (!socket.write(chunk)) {
        await Promise.race([new Promise<void>((resolve) => socket.once("drain", resolve)), result.then(() => {})]);
      }
    }
    const raw = await result;
    expect(raw).toContain("400 Bad Request");
    expect(sent).toBeLessThan(4 * 1024 * 1024);
    expect(process.memoryUsage().rss - rssBefore).toBeLessThan(32 * 1024 * 1024);
  });

  it("times out an incomplete slow chunked upload", async () => {
    const socket = await openSocket();
    const result = response(socket);
    socket.write([
      "POST /v1/authorize HTTP/1.1", `Host: 127.0.0.1:${port}`,
      `Authorization: Bearer ${token}`, "Content-Type: application/json",
      "Transfer-Encoding: chunked", "Connection: close", "", "1\r\n{\r\n",
    ].join("\r\n"));
    expect(await result).toContain("408 Request Timeout");
  });

  it("does not let a slow upload block a concurrent valid request", async () => {
    const slow = await openSocket();
    const slowResult = response(slow);
    slow.write([
      "POST /v1/authorize HTTP/1.1", `Host: 127.0.0.1:${port}`,
      `Authorization: Bearer ${token}`, "Content-Type: application/json",
      "Transfer-Encoding: chunked", "Connection: close", "", "",
    ].join("\r\n"));

    const normal = await openSocket();
    const normalResult = response(normal);
    normal.end([
      "POST /v1/authorize HTTP/1.1", `Host: 127.0.0.1:${port}`,
      `Authorization: Bearer ${token}`, "Content-Type: application/json",
      `Content-Length: ${Buffer.byteLength(body)}`, "Connection: close", "", body,
    ].join("\r\n"));

    expect(await normalResult).toContain("200 OK");
    expect(await slowResult).toContain("408 Request Timeout");
  });

  it("rejects a body shorter than its declared Content-Length", async () => {
    const socket = await openSocket();
    const result = response(socket);
    socket.end([
      "POST /v1/authorize HTTP/1.1", `Host: 127.0.0.1:${port}`,
      `Authorization: Bearer ${token}`, "Content-Type: application/json",
      `Content-Length: ${Buffer.byteLength(body) + 1}`, "Connection: close", "", body,
    ].join("\r\n"));
    expect(await result).toContain("400 Bad Request");
  });

  it("bounds concurrent never-ending chunked requests", async () => {
    const started = Date.now();
    const sockets = await Promise.all(Array.from({ length: 8 }, () => openSocket()));
    const results = sockets.map(response);
    for (const socket of sockets) {
      socket.write([
        "POST /v1/authorize HTTP/1.1", `Host: 127.0.0.1:${port}`,
        `Authorization: Bearer ${token}`, "Content-Type: application/json",
        "Transfer-Encoding: chunked", "Connection: close", "", "",
      ].join("\r\n"));
    }
    const raw = await Promise.all(results);
    expect(raw.every((value) => value.includes("408 Request Timeout"))).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("accepts an exact-boundary body", async () => {
    const exact = `${body}${" ".repeat(MANAGED_EGRESS_MAX_BODY_BYTES - Buffer.byteLength(body))}`;
    const socket = await openSocket();
    const result = response(socket);
    socket.end([
      "POST /v1/authorize HTTP/1.1", `Host: 127.0.0.1:${port}`,
      `Authorization: Bearer ${token}`, "Content-Type: application/json",
      `Content-Length: ${MANAGED_EGRESS_MAX_BODY_BYTES}`, "Connection: close", "", exact,
    ].join("\r\n"));
    expect(await result).toContain("200 OK");
  });
});
