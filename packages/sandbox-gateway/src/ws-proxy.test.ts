import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { startGateway, type GatewayHandle } from "./gateway.js";
import { startFakeBackend, type FakeBackend } from "../test/fake-backend.js";

const SECRET = "gateway-secret";
const SESSION_ID = "s1";

function mint(overrides: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = { sub: "u1", sid: SESSION_ID, iat: now, exp: now + 600, ...overrides };
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const signingInput = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}`;
  const sig = createHmac("sha256", SECRET).update(signingInput).digest("base64url");
  return `${signingInput}.${sig}`;
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

function waitForMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    ws.once("message", (data) => resolve(data.toString()));
    ws.once("error", reject);
  });
}

function waitForClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

describe("ws-proxy", () => {
  let backend: FakeBackend;
  let gateway: GatewayHandle;
  let wsBase: string;

  beforeEach(async () => {
    backend = await startFakeBackend();
    gateway = startGateway({
      port: 0,
      sessionId: SESSION_ID,
      jwtSecret: SECRET,
      targets: { ttyd: backend.ttydPort, vscode: backend.vscodePort },
    });
    const address = gateway.server.address();
    if (address === null || typeof address === "string") throw new Error("no gateway port");
    wsBase = `ws://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await gateway.close();
    await backend.close();
  });

  it("round-trips a frame through the ttyd echo backend", async () => {
    const client = new WebSocket(`${wsBase}/ttyd/?token=${mint()}`);
    await waitForOpen(client);

    const reply = waitForMessage(client);
    client.send("hello-ttyd");
    await expect(reply).resolves.toBe("hello-ttyd");

    client.close();
    await waitForClose(client);
  });

  it("round-trips a frame through the vscode echo backend", async () => {
    const client = new WebSocket(`${wsBase}/vscode/?token=${mint()}`);
    await waitForOpen(client);

    const reply = waitForMessage(client);
    client.send("hello-vscode");
    await expect(reply).resolves.toBe("hello-vscode");

    client.close();
    await waitForClose(client);
  });

  it("forwards the tty subprotocol to the ttyd backend", async () => {
    const client = new WebSocket(`${wsBase}/ttyd/?token=${mint()}`);
    await waitForOpen(client);
    // The gateway's outbound connection to the (fake) backend is a separate
    // handshake from the client<->gateway one and isn't guaranteed complete
    // just because the client saw "open" — round-trip a frame first so the
    // backend has definitely finished its handshake (and recorded the
    // subprotocol header) before asserting on it.
    const reply = waitForMessage(client);
    client.send("ping");
    await reply;
    expect(backend.lastTtydProtocol()).toBe("tty");
    client.close();
    await waitForClose(client);
  });

  it("does not forward a subprotocol to the vscode backend", async () => {
    const client = new WebSocket(`${wsBase}/vscode/?token=${mint()}`);
    await waitForOpen(client);
    const reply = waitForMessage(client);
    client.send("ping");
    await reply;
    expect(backend.lastVscodeProtocol()).toBeUndefined();
    client.close();
    await waitForClose(client);
  });

  it("buffers frames sent before the backend connection opens", async () => {
    const client = new WebSocket(`${wsBase}/ttyd/?token=${mint()}`);
    // Send immediately, before the client's own "open" — the gateway's
    // client-side socket is open (frames can be sent), but the gateway's
    // outbound connection to the backend may not have completed yet.
    const opened = waitForOpen(client);
    const reply = waitForMessage(client);
    await opened;
    client.send("buffered-frame");
    await expect(reply).resolves.toBe("buffered-frame");
    client.close();
    await waitForClose(client);
  });

  it("rejects an unauthenticated upgrade with a close code", async () => {
    const client = new WebSocket(`${wsBase}/ttyd/`);
    const closed = waitForClose(client);
    const result = await closed;
    expect(result.code).toBe(4001);
  });

  it("rejects an upgrade with an expired token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const client = new WebSocket(`${wsBase}/ttyd/?token=${mint({ iat: now - 1200, exp: now - 600 })}`);
    const result = await waitForClose(client);
    expect(result.code).toBe(4001);
  });
});
