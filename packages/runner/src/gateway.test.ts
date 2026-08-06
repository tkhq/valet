import { beforeAll, describe, expect, it, vi } from "vitest";

// Set before gateway.js is imported so the JWT middleware has real key material
// to verify against (HMAC import rejects a zero-length key).
const JWT_SECRET = "test-jwt-secret";
process.env.JWT_SECRET = JWT_SECRET;

// git-setup.ts imports Bun's `$` shell helper, which does not resolve under
// Node. Stub it so the credential-helper route is exercisable here.
vi.mock("./git-setup.js", () => ({
  getCredentialSecret: () => "test-credential-secret",
}));

/**
 * The gateway's security model is "reachability matches authentication":
 * anything served on the tunnelled port requires a JWT, and anything
 * unauthenticated is bound to loopback only. These tests pin both halves of
 * that, because a regression in either one silently re-exposes the
 * control-plane API to the public internet.
 */

interface ServeOptions {
  port?: number;
  hostname?: string;
  fetch?: (req: Request, server: unknown) => Promise<Response> | Response;
  websocket?: unknown;
  idleTimeout?: number;
}

const serveCalls: ServeOptions[] = [];

function base64Url(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Mints an HS256 JWT in the shape `verifyJWT` expects. */
async function mintToken(secret = JWT_SECRET): Promise<string> {
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({ sub: "user-1", sid: "session-1", exp: Math.floor(Date.now() / 1000) + 600 }),
  );
  const signingInput = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput)),
  );
  return `${signingInput}.${base64Url(signature)}`;
}

let publicApp: { fetch: (req: Request) => Response | Promise<Response> };
let internalApp: { fetch: (req: Request) => Response | Promise<Response> };

beforeAll(async () => {
  // gateway.ts calls Bun.serve at startup; vitest runs on Node, so stub it and
  // capture the listener configuration instead of opening real sockets.
  (globalThis as unknown as { Bun: { serve: (o: ServeOptions) => void } }).Bun = {
    serve: (options: ServeOptions) => {
      serveCalls.push(options);
    },
  };

  const gateway = await import("./gateway.js");
  gateway.startGateway(9000, {}, 9001);

  publicApp = gateway.publicApp;
  internalApp = gateway.internalApp;
});

describe("gateway listener bindings", () => {
  it("starts exactly two listeners", () => {
    expect(serveCalls).toHaveLength(2);
  });

  it("binds the internal control-plane listener to 127.0.0.1", () => {
    const internal = serveCalls.find((c) => c.port === 9001);
    expect(internal).toBeDefined();
    expect(internal?.hostname).toBe("127.0.0.1");
  });

  it("leaves the public listener on the default (all-interfaces) binding", () => {
    const publicListener = serveCalls.find((c) => c.port === 9000);
    expect(publicListener).toBeDefined();
    expect(publicListener?.hostname).toBeUndefined();
  });
});

describe("public listener route surface", () => {
  it("does not serve the control-plane API", async () => {
    const res = await publicApp.fetch(
      new Request("http://localhost:9000/api/secrets/run", {
        method: "POST",
        body: JSON.stringify({ command: "id", env: {} }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(res.status).toBe(404);
  });

  it.each([
    "/api/secrets/list",
    "/api/secrets/inject",
    "/api/tools/call",
    "/api/spawn-child",
    "/api/memory",
  ])("does not serve %s", async (path) => {
    const res = await publicApp.fetch(new Request(`http://localhost:9000${path}`));
    expect(res.status).toBe(404);
  });

  it("does not serve the git credential helper", async () => {
    const res = await publicApp.fetch(
      new Request("http://localhost:9000/git/credentials", { method: "POST", body: "host=github.com" }),
    );
    expect(res.status).toBe(404);
  });

  it("rejects unauthenticated OpenCode proxy requests", async () => {
    const res = await publicApp.fetch(new Request("http://localhost:9000/opencode/session"));
    expect(res.status).toBe(401);
  });

  it("rejects OpenCode proxy requests carrying an invalid token", async () => {
    const res = await publicApp.fetch(
      new Request("http://localhost:9000/opencode/session", {
        headers: { Authorization: "Bearer not-a-real-jwt" },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("still serves the unauthenticated health check", async () => {
    const res = await publicApp.fetch(new Request("http://localhost:9000/health"));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: "ok" });
  });
});

describe("internal listener route surface", () => {
  it("serves the control-plane API", async () => {
    const res = await internalApp.fetch(
      new Request("http://127.0.0.1:9001/api/secrets/run", {
        method: "POST",
        body: JSON.stringify({ command: "id", env: {} }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    // Reached the handler rather than falling through to Hono's 404.
    expect(res.status).not.toBe(404);
  });

  it("rejects git credential requests without the per-session secret", async () => {
    const res = await internalApp.fetch(
      new Request("http://127.0.0.1:9001/git/credentials", {
        method: "POST",
        body: "host=github.com",
      }),
    );
    expect(res.status).toBe(403);
  });

  it("rejects git credential requests with the wrong per-session secret", async () => {
    const res = await internalApp.fetch(
      new Request("http://127.0.0.1:9001/git/credentials", {
        method: "POST",
        body: "host=github.com",
        headers: { "x-credential-secret": "wrong" },
      }),
    );
    expect(res.status).toBe(403);
  });

  it("serves git credential requests carrying the per-session secret", async () => {
    const res = await internalApp.fetch(
      new Request("http://127.0.0.1:9001/git/credentials", {
        method: "POST",
        body: "host=github.com",
        headers: { "x-credential-secret": "test-credential-secret" },
      }),
    );
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(404);
  });

  it("does not serve the interactive proxy routes", async () => {
    const res = await internalApp.fetch(new Request("http://127.0.0.1:9001/vscode/"));
    expect(res.status).toBe(404);
  });
});

/**
 * `startGateway` registers every route before it opens either listener. These
 * drive the listener's own `fetch` handler (rather than the Hono app directly)
 * so a future reordering that starts a listener ahead of its route
 * registrations fails here instead of in production.
 */
describe("listener handlers serve their full route set", () => {
  it("routes control-plane requests through the internal listener handler", async () => {
    const internal = serveCalls.find((c) => c.port === 9001);
    const res = await internal!.fetch!(
      new Request("http://127.0.0.1:9001/api/tunnels"),
      undefined,
    );
    expect(res.status).toBe(200);
  });

  it("does not expose control-plane routes through the public listener handler", async () => {
    const publicListener = serveCalls.find((c) => c.port === 9000);
    const res = await publicListener!.fetch!(
      new Request("http://localhost:9000/api/tunnels"),
      undefined,
    );
    expect(res.status).toBe(404);
  });
});

/**
 * Bearer parsing is anchored: only a header that actually starts with the
 * scheme yields a token. An unanchored `replace("Bearer ", "")` would also
 * accept a scheme-less header verbatim, silently widening what counts as a
 * credential.
 */
describe("bearer token parsing", () => {
  it("authenticates a well-formed Bearer header", async () => {
    const token = await mintToken();
    const res = await publicApp.fetch(
      new Request("http://localhost:9000/opencode/session", {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    // Past auth; the proxy target is not running under test, so this is a 502.
    expect(res.status).not.toBe(401);
  });

  it("rejects a valid token sent with no scheme", async () => {
    const token = await mintToken();
    const res = await publicApp.fetch(
      new Request("http://localhost:9000/opencode/session", {
        headers: { Authorization: token },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects a valid token behind a different scheme", async () => {
    const token = await mintToken();
    const res = await publicApp.fetch(
      new Request("http://localhost:9000/opencode/session", {
        headers: { Authorization: `Basic Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects a Bearer header with no separating space", async () => {
    const token = await mintToken();
    const res = await publicApp.fetch(
      new Request("http://localhost:9000/opencode/session", {
        headers: { Authorization: `Bearer${token}` },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects a prefix-only Bearer header", async () => {
    const res = await publicApp.fetch(
      new Request("http://localhost:9000/opencode/session", {
        headers: { Authorization: "Bearer " },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("still falls back to the token query param when the header is unusable", async () => {
    const token = await mintToken();
    const res = await publicApp.fetch(
      new Request(`http://localhost:9000/opencode/session?token=${token}`, {
        headers: { Authorization: "Bearer " },
      }),
    );
    expect(res.status).not.toBe(401);
  });

  it("rejects a token signed with the wrong secret", async () => {
    const token = await mintToken("not-the-gateway-secret");
    const res = await publicApp.fetch(
      new Request("http://localhost:9000/opencode/session", {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(401);
  });
});
