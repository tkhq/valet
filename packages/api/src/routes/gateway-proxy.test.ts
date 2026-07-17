/**
 * `ALL /api/sessions/:id/gateway/*` (HTTP) + `GET .../gateway/*` (WS
 * upgrade) — the sandbox auth gateway reverse-proxy (Task 6, sandbox auth
 * gateway plan).
 *
 * Exercises a REAL in-process `@valet/sandbox-gateway` (`startGateway`)
 * fronting real fake ttyd/vscode backends (`@valet/sandbox-gateway`'s
 * `test-helpers`), reached through a purpose-built `SandboxProvider` whose
 * sandboxes implement `gatewayEndpoint()` — no mocking of the proxy route
 * itself. Covers the brief's five cases: owner success + path rewrite,
 * non-owner 404, no-gateway 409, unreachable-backend 502, and a WS
 * round-trip through the api hop to the fake ttyd echo.
 */
import { createServer, type AddressInfo } from "node:net";
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  VirtualSandbox,
  type GatewayEndpoint,
  type Sandbox,
  type SandboxCapabilities,
  type SandboxCreateOpts,
  type SandboxProvider,
  type SandboxStatus,
} from "@valet/engine";
import { startGateway, type GatewayHandle } from "@valet/sandbox-gateway";
import { startFakeBackend, type FakeBackend } from "@valet/sandbox-gateway/test-helpers";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { deriveSandboxJwtSecret } from "../auth/sandbox-tokens.js";
import { internalToken } from "../lib/internal-auth.js";
import { agentSessions } from "../schema/index.js";
import { closeBackendOnClientClose } from "./gateway-proxy.js";
import { WebSocket as BackendWebSocket } from "ws";

/** A `Sandbox` whose `gatewayEndpoint()` is test-controlled (constant
 * per-instance) — everything else (fs/exec) is inherited from
 * `VirtualSandbox` and unused by these tests. */
class GatewayTestSandbox extends VirtualSandbox {
  constructor(id: string, private readonly endpoint: GatewayEndpoint | null) {
    super(id);
  }
  async gatewayEndpoint(): Promise<GatewayEndpoint | null> {
    return this.endpoint;
  }
}

/** Purpose-built fake provider (brief's suggested alternative to extending
 * `VirtualSandboxProvider`, whose sandbox map is private and can't be
 * subclassed into): every sandbox it creates reports the same fixed
 * `gatewayEndpoint()`, or none at all when `endpoint` is `null`. */
class GatewayTestSandboxProvider implements SandboxProvider {
  readonly backend = "gateway-test";
  private sandboxes = new Map<string, GatewayTestSandbox>();
  private nextId = 1;

  constructor(private readonly endpoint: GatewayEndpoint | null) {}

  capabilities(): SandboxCapabilities {
    return {
      snapshot: "none",
      persistentWorkspace: false,
      tunnels: false,
      warmPool: false,
      hibernation: false,
      coldStartEstimateMs: 0,
    };
  }

  async create(_opts: SandboxCreateOpts): Promise<Sandbox> {
    const id = `gwtest-${this.nextId++}`;
    const sb = new GatewayTestSandbox(id, this.endpoint);
    this.sandboxes.set(id, sb);
    return sb;
  }

  async restore(id: string): Promise<Sandbox> {
    const sb = this.sandboxes.get(id);
    if (!sb) throw new Error(`gateway-test sandbox not found: ${id}`);
    return sb;
  }

  async destroy(id: string): Promise<void> {
    const sb = this.sandboxes.get(id);
    if (sb) await sb.destroy?.();
    this.sandboxes.delete(id);
  }

  async status(id: string): Promise<SandboxStatus> {
    return this.sandboxes.has(id) ? { id, state: "ready", startedAt: Date.now() } : { id, state: "released" };
  }
}

/** Hibernation-capable variant of `GatewayTestSandboxProvider` (sandbox
 * hibernation plan, Task 4's gateway-touch wake test): same fixed
 * `gatewayEndpoint()` behavior, plus tracked `suspend`/`resume` so a test
 * can drive a session into `suspended` and assert the gateway proxy's 409
 * path kicks a resume via `attachment.warm()`. */
class HibernatingGatewayTestSandboxProvider implements SandboxProvider {
  readonly backend = "gateway-hib-test";
  readonly resumeCalls: string[] = [];
  private sandboxes = new Map<string, GatewayTestSandbox>();
  private nextId = 1;

  constructor(private readonly endpoint: GatewayEndpoint | null) {}

  capabilities(): SandboxCapabilities {
    return {
      snapshot: "none",
      persistentWorkspace: false,
      tunnels: false,
      warmPool: false,
      hibernation: true,
      coldStartEstimateMs: 0,
    };
  }

  async create(_opts: SandboxCreateOpts): Promise<Sandbox> {
    const id = `gwhib-${this.nextId++}`;
    const sb = new GatewayTestSandbox(id, this.endpoint);
    this.sandboxes.set(id, sb);
    return sb;
  }

  async restore(id: string): Promise<Sandbox> {
    const sb = this.sandboxes.get(id);
    if (!sb) throw new Error(`gateway-hib-test sandbox not found: ${id}`);
    return sb;
  }

  async destroy(id: string): Promise<void> {
    const sb = this.sandboxes.get(id);
    if (sb) await sb.destroy?.();
    this.sandboxes.delete(id);
  }

  async status(id: string): Promise<SandboxStatus> {
    return this.sandboxes.has(id) ? { id, state: "ready", startedAt: Date.now() } : { id, state: "released" };
  }

  async suspend(_id: string): Promise<void> {}

  async resume(id: string): Promise<void> {
    this.resumeCalls.push(id);
  }
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

async function seedSession(
  api: TestApi,
  opts: { id: string; userId: string },
): Promise<void> {
  const now = Date.now();
  await api.providers.db.insert(agentSessions).values({
    id: opts.id,
    userId: opts.userId,
    orgId: "local-org",
    workspace: `/tmp/gw-proxy-test-${opts.id}`,
    status: "active",
    ownerType: "user",
    ownerId: opts.userId,
    profile: "full",
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * Builds (or restores) the engine session and forces its sandbox attachment
 * to `ready` via `ensureReady` — mirroring the real "already provisioned"
 * precondition the route requires. The engine only auto-warms a sandbox
 * when a *turn* is claimed (`Thread.runTurn`, per `warmSandboxOnClaim`);
 * these tests never run a turn, so without this the attachment would stay
 * `detached` and every case would 409 regardless of what the route itself
 * does — this helper isolates that from the route behavior under test.
 */
async function warmSandbox(api: TestApi, opts: { id: string; userId: string }) {
  const session = await api.providers.engineHost.sessionFor(opts.id, {
    userId: opts.userId,
    orgId: "local-org",
    workspace: `/tmp/gw-proxy-test-${opts.id}`,
    profile: "full",
  });
  await session.attachment.ensureReady({ timeoutMs: 5_000 });
  return session;
}

describe("closeBackendOnClientClose (Fix 3: throw-safe WS close mirroring)", () => {
  it("falls back to terminate() when mirroring an oversize close reason throws", () => {
    let terminated = false;
    const fakeBackend = {
      readyState: BackendWebSocket.OPEN,
      close(_code?: number, reason?: string) {
        // Mirrors `ws`'s real behavior: throws when the reason encodes to
        // more than 123 bytes rather than sending a malformed close frame.
        if (reason && Buffer.byteLength(reason, "utf8") > 123) {
          throw new RangeError("Reason must be less than 123 bytes");
        }
      },
      terminate() {
        terminated = true;
      },
    };

    expect(() => closeBackendOnClientClose(fakeBackend, 1000, "x".repeat(200))).not.toThrow();
    expect(terminated).toBe(true);
  });

  it("mirrors a normal close without falling back to terminate()", () => {
    let terminated = false;
    let mirrored: { code?: number; reason?: string } | undefined;
    const fakeBackend = {
      readyState: BackendWebSocket.OPEN,
      close(code?: number, reason?: string) {
        mirrored = { code, reason };
      },
      terminate() {
        terminated = true;
      },
    };

    closeBackendOnClientClose(fakeBackend, 1000, "bye");
    expect(mirrored).toEqual({ code: 1000, reason: "bye" });
    expect(terminated).toBe(false);
  });

  it("terminates directly when the backend isn't open", () => {
    let terminated = false;
    const fakeBackend = {
      readyState: BackendWebSocket.CLOSING,
      close() {
        throw new Error("should not be called");
      },
      terminate() {
        terminated = true;
      },
    };

    closeBackendOnClientClose(fakeBackend, 1000, "bye");
    expect(terminated).toBe(true);
  });
});

describe("session gateway reverse-proxy", () => {
  let api: TestApi | undefined;
  let fakeBackend: FakeBackend | undefined;
  let gateway: GatewayHandle | undefined;

  afterEach(async () => {
    await api?.cleanup();
    api = undefined;
    await gateway?.close();
    gateway = undefined;
    await fakeBackend?.close();
    fakeBackend = undefined;
  });

  it("owner GET proxies to the gateway with the path rewritten", async () => {
    const sessionId = "gw-owner";
    fakeBackend = await startFakeBackend();
    const jwtSecret = deriveSandboxJwtSecret(internalToken(), sessionId);
    gateway = startGateway({
      port: 0,
      sessionId,
      jwtSecret,
      targets: { ttyd: fakeBackend.ttydPort, vscode: fakeBackend.vscodePort },
    });
    const gatewayPort = (gateway.server.address() as AddressInfo).port;

    api = await bootTestApi({
      sandboxProvider: new GatewayTestSandboxProvider({ host: "127.0.0.1", port: gatewayPort }),
    });
    await seedSession(api, { id: sessionId, userId: "local-user" });
    await warmSandbox(api, { id: sessionId, userId: "local-user" });

    // The sandbox gateway daemon enforces its OWN auth independent of this
    // route's session-ownership gate (see the module doc comment) — a
    // request with a valid valet session but no `?token=` still 401s at
    // the sandbox gateway itself. Mint one the way the browser would.
    const mintRes = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/sandbox-jwt`, {
      method: "POST",
      headers: { "x-valet-test-user-id": "local-user" },
    });
    expect(mintRes.status).toBe(200);
    const { token } = (await mintRes.json()) as { token: string };

    const res = await fetch(
      `${api.baseUrl}/api/sessions/${sessionId}/gateway/vscode/?token=${encodeURIComponent(token)}`,
      { headers: { "x-valet-test-user-id": "local-user" } },
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toBe("vscode-ok");
  });

  it("rewrites the gateway's Set-Cookie Path to this session's proxy prefix, confining it away from other sessions", async () => {
    const sessionId1 = "gw-cookie-1";
    const sessionId2 = "gw-cookie-2";

    const fakeBackend1 = await startFakeBackend();
    const jwtSecret1 = deriveSandboxJwtSecret(internalToken(), sessionId1);
    const gateway1 = startGateway({
      port: 0,
      sessionId: sessionId1,
      jwtSecret: jwtSecret1,
      targets: { ttyd: fakeBackend1.ttydPort, vscode: fakeBackend1.vscodePort },
    });
    const gatewayPort1 = (gateway1.server.address() as AddressInfo).port;

    const fakeBackend2 = await startFakeBackend();
    const jwtSecret2 = deriveSandboxJwtSecret(internalToken(), sessionId2);
    const gateway2 = startGateway({
      port: 0,
      sessionId: sessionId2,
      jwtSecret: jwtSecret2,
      targets: { ttyd: fakeBackend2.ttydPort, vscode: fakeBackend2.vscodePort },
    });
    const gatewayPort2 = (gateway2.server.address() as AddressInfo).port;

    // Both sessions share one api process, each with its own gateway-backed
    // sandbox — a purpose-built provider whose `create()` return alternates
    // isn't available here, so seed both sessions against a single provider
    // instance keyed by whichever endpoint each session's own `sessionFor`
    // resolves. `GatewayTestSandboxProvider` is fixed to one endpoint per
    // instance, so this test drives two full `bootTestApi` instances instead
    // — mirroring how the other cases each own one.
    try {
      api = await bootTestApi({
        sandboxProvider: new GatewayTestSandboxProvider({ host: "127.0.0.1", port: gatewayPort1 }),
      });
      await seedSession(api, { id: sessionId1, userId: "local-user" });
      await warmSandbox(api, { id: sessionId1, userId: "local-user" });

      const mintRes1 = await fetch(`${api.baseUrl}/api/sessions/${sessionId1}/sandbox-jwt`, {
        method: "POST",
        headers: { "x-valet-test-user-id": "local-user" },
      });
      const { token: token1 } = (await mintRes1.json()) as { token: string };

      const res1 = await fetch(
        `${api.baseUrl}/api/sessions/${sessionId1}/gateway/vscode/?token=${encodeURIComponent(token1)}`,
        { headers: { "x-valet-test-user-id": "local-user" } },
      );
      expect(res1.status).toBe(200);
      const setCookie1 = res1.headers.get("set-cookie");
      expect(setCookie1).toBeTruthy();
      expect(setCookie1).toContain(`Path=/api/sessions/${sessionId1}/gateway`);
      expect(setCookie1).not.toMatch(/Path=\/;/);

      // Extract the raw gateway_session cookie pair a real browser would
      // have stored (scoped, in a real browser, to session 1's own proxy
      // path — never attached to a request for session 2). Simulate the
      // failure mode this fix prevents: hand-forward that cookie into a
      // request for session 2's proxy anyway (as if path scoping were
      // absent) and confirm the sandbox-side auth boundary still rejects it
      // — the cookie filter + path rewrite together confine session 1's
      // cookie away from session 2.
      const cookiePair = setCookie1?.split(";")[0];
      expect(cookiePair).toMatch(/^gateway_session=/);

      await api.cleanup();
      api = undefined;

      api = await bootTestApi({
        sandboxProvider: new GatewayTestSandboxProvider({ host: "127.0.0.1", port: gatewayPort2 }),
      });
      await seedSession(api, { id: sessionId2, userId: "local-user" });
      await warmSandbox(api, { id: sessionId2, userId: "local-user" });

      const res2 = await fetch(`${api.baseUrl}/api/sessions/${sessionId2}/gateway/vscode/`, {
        headers: { "x-valet-test-user-id": "local-user", Cookie: cookiePair ?? "" },
      });
      // Session 1's cookie doesn't authenticate session 2's gateway (each
      // gateway's session store + JWT secret is per-sessionId) — no token
      // and a foreign cookie both fail, surfacing as the sandbox gateway's
      // own 401, not a 200 that would mean the cookie leaked across
      // sessions and worked.
      expect(res2.status).toBe(401);
    } finally {
      await gateway1.close();
      await fakeBackend1.close();
      await gateway2.close();
      await fakeBackend2.close();
    }
  });

  it("404s for a session owned by a different user", async () => {
    const sessionId = "gw-nonowner";
    fakeBackend = await startFakeBackend();
    const jwtSecret = deriveSandboxJwtSecret(internalToken(), sessionId);
    gateway = startGateway({
      port: 0,
      sessionId,
      jwtSecret,
      targets: { ttyd: fakeBackend.ttydPort, vscode: fakeBackend.vscodePort },
    });
    const gatewayPort = (gateway.server.address() as AddressInfo).port;

    api = await bootTestApi({
      sandboxProvider: new GatewayTestSandboxProvider({ host: "127.0.0.1", port: gatewayPort }),
    });
    await seedSession(api, { id: sessionId, userId: "local-user" });

    const res = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/gateway/vscode/`, {
      headers: { "x-valet-test-user-id": "test-member" },
    });
    expect(res.status).toBe(404);
  });

  it("409s with wake:true when the sandbox has no gateway", async () => {
    const sessionId = "gw-no-gateway";
    api = await bootTestApi({
      sandboxProvider: new GatewayTestSandboxProvider(null),
    });
    await seedSession(api, { id: sessionId, userId: "local-user" });
    // Ready, but the sandbox reports no gateway endpoint at all (headless
    // profile / provider without gateway support) — distinct from the
    // never-provisioned case, both of which the route folds into the same
    // 409.
    await warmSandbox(api, { id: sessionId, userId: "local-user" });

    const res = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/gateway/vscode/`, {
      headers: { "x-valet-test-user-id": "local-user" },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; wake: boolean };
    expect(body).toEqual({ error: "sandbox not ready", wake: true });
  });

  it("kicks a resume (attachment.warm()) when the sandbox is suspended (sandbox hibernation plan, Task 4)", async () => {
    const sessionId = "gw-suspended";
    const provider = new HibernatingGatewayTestSandboxProvider({ host: "127.0.0.1", port: 1 });
    api = await bootTestApi({ sandboxProvider: provider });
    await seedSession(api, { id: sessionId, userId: "local-user" });
    const session = await warmSandbox(api, { id: sessionId, userId: "local-user" });
    const sandboxId = session.attachment.current()?.id;
    expect(sandboxId).toBeDefined();

    await session.attachment.suspend();
    expect(session.attachment.state).toBe("suspended");

    const res = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/gateway/vscode/`, {
      headers: { "x-valet-test-user-id": "local-user" },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; wake: boolean };
    expect(body).toEqual({ error: "sandbox not ready", wake: true });

    // warm() is fire-and-forget — the resume lands asynchronously.
    await vi.waitFor(() => {
      expect(provider.resumeCalls).toEqual([sandboxId]);
    });
    await vi.waitFor(() => {
      expect(session.attachment.state).toBe("ready");
    });
  });

  it("502s when the gateway endpoint is unreachable", async () => {
    const sessionId = "gw-unreachable";
    const deadPort = await getFreePort(); // freed immediately; nothing listens on it

    api = await bootTestApi({
      sandboxProvider: new GatewayTestSandboxProvider({ host: "127.0.0.1", port: deadPort }),
    });
    await seedSession(api, { id: sessionId, userId: "local-user" });
    await warmSandbox(api, { id: sessionId, userId: "local-user" });

    const res = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/gateway/vscode/`, {
      headers: { "x-valet-test-user-id": "local-user" },
    });
    expect(res.status).toBe(502);
  });

  it("WS: round-trips a frame through the api hop to the fake ttyd echo", async () => {
    const sessionId = "gw-ws";
    fakeBackend = await startFakeBackend();
    const jwtSecret = deriveSandboxJwtSecret(internalToken(), sessionId);
    gateway = startGateway({
      port: 0,
      sessionId,
      jwtSecret,
      targets: { ttyd: fakeBackend.ttydPort, vscode: fakeBackend.vscodePort },
    });
    const gatewayPort = (gateway.server.address() as AddressInfo).port;

    api = await bootTestApi({
      sandboxProvider: new GatewayTestSandboxProvider({ host: "127.0.0.1", port: gatewayPort }),
    });
    await seedSession(api, { id: sessionId, userId: "local-user" });
    await warmSandbox(api, { id: sessionId, userId: "local-user" });

    // Mint the gateway JWT the way the browser would: through the route,
    // not by hand — proves the sandbox-jwt route + this proxy share the
    // same token.
    const mintRes = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/sandbox-jwt`, {
      method: "POST",
      headers: { "x-valet-test-user-id": "local-user" },
    });
    expect(mintRes.status).toBe(200);
    const { token } = (await mintRes.json()) as { token: string };

    // Native WebSocket can't set custom headers, so this relies on the
    // stub-mode default identity (`local-user`) rather than the
    // `x-valet-test-user-id` impersonation header the HTTP cases use — the
    // session above is seeded owned by `local-user` for exactly that reason.
    const wsUrl = `${api.wsUrl}/api/sessions/${sessionId}/gateway/ttyd/?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(wsUrl, "tty");

    const echoed = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("WS echo timed out")), 5_000);
      ws.onopen = () => ws.send("hello-through-the-gateway");
      ws.onmessage = (evt) => {
        clearTimeout(timeout);
        resolve(typeof evt.data === "string" ? evt.data : String(evt.data));
      };
      ws.onerror = () => {
        clearTimeout(timeout);
        reject(new Error("ws error"));
      };
    });
    ws.close();

    expect(echoed).toBe("hello-through-the-gateway");
  });

  it("HTTP proxy stamps EngineHost.touchGatewayActivity on every proxied request (final-review fix wave, hibernation arc)", async () => {
    const sessionId = "gw-touch-http";
    fakeBackend = await startFakeBackend();
    const jwtSecret = deriveSandboxJwtSecret(internalToken(), sessionId);
    gateway = startGateway({
      port: 0,
      sessionId,
      jwtSecret,
      targets: { ttyd: fakeBackend.ttydPort, vscode: fakeBackend.vscodePort },
    });
    const gatewayPort = (gateway.server.address() as AddressInfo).port;

    api = await bootTestApi({
      sandboxProvider: new GatewayTestSandboxProvider({ host: "127.0.0.1", port: gatewayPort }),
    });
    await seedSession(api, { id: sessionId, userId: "local-user" });
    await warmSandbox(api, { id: sessionId, userId: "local-user" });

    const touchSpy = vi.spyOn(api.providers.engineHost, "touchGatewayActivity");

    const mintRes = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/sandbox-jwt`, {
      method: "POST",
      headers: { "x-valet-test-user-id": "local-user" },
    });
    const { token } = (await mintRes.json()) as { token: string };

    const res = await fetch(
      `${api.baseUrl}/api/sessions/${sessionId}/gateway/vscode/?token=${encodeURIComponent(token)}`,
      { headers: { "x-valet-test-user-id": "local-user" } },
    );
    expect(res.status).toBe(200);
    expect(touchSpy).toHaveBeenCalledWith(sessionId);
  });

  it("WS proxy stamps EngineHost.touchGatewayActivity on open and on client->backend messages (final-review fix wave, hibernation arc)", async () => {
    const sessionId = "gw-touch-ws";
    fakeBackend = await startFakeBackend();
    const jwtSecret = deriveSandboxJwtSecret(internalToken(), sessionId);
    gateway = startGateway({
      port: 0,
      sessionId,
      jwtSecret,
      targets: { ttyd: fakeBackend.ttydPort, vscode: fakeBackend.vscodePort },
    });
    const gatewayPort = (gateway.server.address() as AddressInfo).port;

    api = await bootTestApi({
      sandboxProvider: new GatewayTestSandboxProvider({ host: "127.0.0.1", port: gatewayPort }),
    });
    await seedSession(api, { id: sessionId, userId: "local-user" });
    await warmSandbox(api, { id: sessionId, userId: "local-user" });

    const touchSpy = vi.spyOn(api.providers.engineHost, "touchGatewayActivity");

    const mintRes = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/sandbox-jwt`, {
      method: "POST",
      headers: { "x-valet-test-user-id": "local-user" },
    });
    const { token } = (await mintRes.json()) as { token: string };

    const wsUrl = `${api.wsUrl}/api/sessions/${sessionId}/gateway/ttyd/?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(wsUrl, "tty");

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("WS echo timed out")), 5_000);
      ws.onopen = () => ws.send("hello");
      ws.onmessage = () => {
        clearTimeout(timeout);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timeout);
        reject(new Error("ws error"));
      };
    });
    ws.close();

    expect(touchSpy).toHaveBeenCalledWith(sessionId);
    // Called at least twice: once for WS `onOpen`, once for the client's
    // `onMessage` frame — the doc comment's "at minimum" stamping points.
    expect(touchSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
