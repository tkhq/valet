import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startGateway, type GatewayHandle } from "./gateway.js";
import { startFakeBackend, type FakeBackend } from "../test/fake-backend.js";

const SECRET = "gateway-secret";
const SESSION_ID = "s1";

function mint(payload: Record<string, unknown>, secret = SECRET): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const signingInput = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}`;
  const sig = createHmac("sha256", secret).update(signingInput).digest("base64url");
  return `${signingInput}.${sig}`;
}

function validToken(overrides: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  return mint({ sub: "u1", sid: SESSION_ID, iat: now, exp: now + 600, ...overrides });
}

function extractCookie(setCookieHeader: string | null): string {
  expect(setCookieHeader).toBeTruthy();
  const match = /gateway_session=([^;]+)/.exec(setCookieHeader ?? "");
  expect(match).not.toBeNull();
  return match ? match[1] : "";
}

describe("startGateway (HTTP)", () => {
  let backend: FakeBackend;
  let gateway: GatewayHandle;
  let baseUrl: string;

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
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await gateway.close();
    await backend.close();
  });

  it("GET /health requires no auth", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("GET /vscode/ with ?token= succeeds and sets the session cookie", async () => {
    const res = await fetch(`${baseUrl}/vscode/?token=${validToken()}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("vscode-ok");
    expect(res.headers.get("set-cookie")).toContain("gateway_session=");
    expect(res.headers.get("set-cookie")).toContain("SameSite=None");
    expect(res.headers.get("set-cookie")).toContain("Secure");
  });

  it("GET /ttyd/ reuses the minted cookie without a token", async () => {
    const first = await fetch(`${baseUrl}/vscode/?token=${validToken()}`);
    const cookie = extractCookie(first.headers.get("set-cookie"));

    const second = await fetch(`${baseUrl}/ttyd/`, {
      headers: { Cookie: `gateway_session=${cookie}` },
    });
    expect(second.status).toBe(200);
    expect(await second.text()).toBe("ttyd-ok");
  });

  it("GET /vscode/ with no token and no cookie is 401", async () => {
    const res = await fetch(`${baseUrl}/vscode/`);
    expect(res.status).toBe(401);
  });

  it("GET /vscode/ with an expired token is 401", async () => {
    const now = Math.floor(Date.now() / 1000);
    const expired = validToken({ iat: now - 1200, exp: now - 600 });
    const res = await fetch(`${baseUrl}/vscode/?token=${expired}`);
    expect(res.status).toBe(401);
  });

  it("502s with a body naming the service when the backend is down", async () => {
    const closedPortGateway = startGateway({
      port: 0,
      sessionId: SESSION_ID,
      jwtSecret: SECRET,
      // Port 1 is reserved/unreachable from userland.
      targets: { ttyd: 1, vscode: backend.vscodePort },
    });
    try {
      const address = closedPortGateway.server.address();
      if (address === null || typeof address === "string") throw new Error("no port");
      const res = await fetch(`http://127.0.0.1:${address.port}/ttyd/?token=${validToken()}`);
      expect(res.status).toBe(502);
      const body = await res.text();
      expect(body.toLowerCase()).toContain("ttyd");
    } finally {
      await closedPortGateway.close();
    }
  });
});
