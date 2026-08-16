/**
 * Matrix tests for the auth middleware ladder (Task 7): first-match-wins
 * across internal token → sandbox token → session → api key → stub → 401.
 * See `buildAuthMiddleware`'s doc comment in `auth.ts` for the exact order.
 */
import { describe, expect, it, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { mintSandboxToken } from "../auth/sandbox-tokens.js";
import { users } from "../schema/index.js";
import { internalToken } from "../lib/internal-auth.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

/** Same cookie-extraction helper as `auth-instance.test.ts` — undici folds
 * multiple `set-cookie` values into one comma-joined header. */
function extractSessionCookie(setCookieHeader: string | null): string {
  expect(setCookieHeader).toBeTruthy();
  const match = setCookieHeader?.match(/better-auth\.session_token=[^;]+/);
  expect(match).toBeTruthy();
  return match![0];
}

describe("auth middleware ladder — stub-mode boots", () => {
  it("a valid x-valet-internal token reaches the route with no c.var.user set", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/memory?path=`, {
      headers: {
        "x-valet-internal": internalToken(),
        "x-valet-owner": "user:local-user",
        "x-valet-actor": "local-user",
      },
    });
    expect(res.status).toBe(200);
  });

  it("a sandbox token reaches memory routes and the owner derives from the token, not headers", async () => {
    api = await bootTestApi();
    const { db } = api.providers;
    const { token } = await mintSandboxToken(db, { sessionId: "sbx-sess", userId: "sbx-user", orgId: "local-org" });

    // Write scoped to the sandbox token's userId, even though a bogus
    // x-valet-owner header rides along (must be ignored — the internal
    // header isn't set here, so `resolveScope`'s internal branch never
    // runs and this exercises pure sandbox-header scoping).
    const putRes = await fetch(`${api.baseUrl}/api/memory`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-valet-sandbox": token,
        "x-valet-owner": "user:someone-else",
      },
      body: JSON.stringify({ path: "notes/from-sandbox.md", content: "hello from sandbox" }),
    });
    expect(putRes.status).toBe(200);

    // Read back via the internal-token path, explicitly scoped to the
    // sandbox token's real userId — proves the write landed on sbx-user's
    // scope, not someone-else's.
    const getRes = await fetch(
      `${api.baseUrl}/api/memory?path=${encodeURIComponent("notes/from-sandbox.md")}`,
      {
        headers: {
          "x-valet-internal": internalToken(),
          "x-valet-owner": "user:sbx-user",
          "x-valet-actor": "sbx-user",
        },
      },
    );
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as { rendered?: string };
    expect(body.rendered).toContain("hello from sandbox");
  });

  it("a garbage x-valet-sandbox token 401s even with VALET_LOCAL_AUTH=1 — explicit credential beats fallback", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/me`, {
      headers: { "x-valet-sandbox": "st_not-a-real-token" },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid sandbox token");
  });

  it("VALET_LOCAL_AUTH=1 with no other credential falls through to the local stub user", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/me`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { email: string };
    expect(body.email).toBe("local@dev");
  });

  it("the test impersonation header still selects a seeded user in stub mode", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/me`, { headers: { "x-valet-test-user-id": "test-member" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { email: string; role: string };
    expect(body.email).toBe("member@dev");
    expect(body.role).toBe("member");
  });

  it("stub off (no VALET_LOCAL_AUTH), no credential at all → 401 unauthorized", async () => {
    api = await bootTestApi();
    const prev = process.env.VALET_LOCAL_AUTH;
    delete process.env.VALET_LOCAL_AUTH;
    try {
      const res = await fetch(`${api.baseUrl}/api/me`);
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("unauthorized");
    } finally {
      if (prev !== undefined) process.env.VALET_LOCAL_AUTH = prev;
    }
  });
});

describe("auth middleware ladder — real-auth boots", () => {
  it("a valid session cookie satisfies a user-scoped route", async () => {
    api = await bootTestApi({ auth: true });

    const signUpRes = await fetch(`${api.baseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Ladder User", email: "ladder@nowhere.test", password: "correct-horse-battery" }),
    });
    expect(signUpRes.status).toBe(200);
    const cookie = extractSessionCookie(signUpRes.headers.get("set-cookie"));

    const meRes = await fetch(`${api.baseUrl}/api/me`, { headers: { cookie } });
    expect(meRes.status).toBe(200);
    const body = (await meRes.json()) as { email: string };
    expect(body.email).toBe("ladder@nowhere.test");
  });

  it("a real x-api-key from auth.api.createApiKey satisfies a user-scoped route", async () => {
    api = await bootTestApi({ auth: true });

    const signUpRes = await fetch(`${api.baseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Key User", email: "key@nowhere.test", password: "correct-horse-battery" }),
    });
    expect(signUpRes.status).toBe(200);
    const cookie = extractSessionCookie(signUpRes.headers.get("set-cookie"));

    const createRes = await fetch(`${api.baseUrl}/api/auth/api-key/create`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "ladder-test-key" }),
    });
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as { id: string; key: string };

    const meRes = await fetch(`${api.baseUrl}/api/me`, { headers: { "x-api-key": created.key } });
    expect(meRes.status).toBe(200);
    const body = (await meRes.json()) as { email: string };
    expect(body.email).toBe("key@nowhere.test");

    // Revoked key → 401 with the exact error copy.
    const deleteRes = await fetch(`${api.baseUrl}/api/auth/api-key/delete`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ keyId: created.id }),
    });
    expect(deleteRes.status).toBe(200);

    const revokedRes = await fetch(`${api.baseUrl}/api/me`, { headers: { "x-api-key": created.key } });
    expect(revokedRes.status).toBe(401);
    const revokedBody = (await revokedRes.json()) as { error: string };
    expect(revokedBody.error).toBe("invalid api key");
  });

  // Deliberately changed from the original 401 assertion: the sandbox rung
  // now rejects valid tokens on non-memory paths with an explicit 403 in
  // the middleware, instead of falling into the handler and 401ing (or
  // TypeError-500ing on routes that read `c.var.user` unguarded).
  it("a valid sandbox token on a user-scoped route (GET /api/me) → 403 'sandbox token not accepted here'", async () => {
    api = await bootTestApi({ auth: true });
    const { db } = api.providers;

    const signUpRes = await fetch(`${api.baseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Org Admin", email: "org-admin@nowhere.test", password: "correct-horse-battery" }),
    });
    expect(signUpRes.status).toBe(200);
    const adminUserRows = await db.select().from(users).where(eq(users.email, "org-admin@nowhere.test")).limit(1);
    const adminUser = adminUserRows[0];
    expect(adminUser).toBeDefined();

    const { token } = await mintSandboxToken(db, {
      sessionId: "sbx-sess-2",
      userId: adminUser!.id,
      orgId: "does-not-matter",
    });

    const meRes = await fetch(`${api.baseUrl}/api/me`, { headers: { "x-valet-sandbox": token } });
    expect(meRes.status).toBe(403);
    const body = (await meRes.json()) as { error: string };
    expect(body.error).toBe("sandbox token not accepted here");
  });

  it("a malformed session cookie falls down the ladder instead of 500ing", async () => {
    api = await bootTestApi({ auth: true });
    // Garbage + oversized cookie value: whether better-auth throws or
    // returns null, the middleware must treat it as "no session". With no
    // other credential and no stub, that lands on the 401 rung — never 500.
    const res = await fetch(`${api.baseUrl}/api/me`, {
      headers: { cookie: `better-auth.session_token=${"garbage.signature".repeat(500)}` },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unauthorized");
  });

  it("a credential-less request 401s — the harness never forces stub auth onto a real-auth boot", async () => {
    api = await bootTestApi({ auth: true });
    const res = await fetch(`${api.baseUrl}/api/me`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unauthorized");
  });

  // The privilege-escalation regression: rung 5 fired on the env var alone,
  // so a deployment with both variables answered every credential-less
  // request with the seeded ADMIN stub identity. `main.ts` now refuses that
  // pair at boot; the rung itself gates on the auth instance so no other
  // caller of `buildAuthMiddleware` can reach the stub under real auth.
  //
  // This reproduces the complete misconfiguration, not a partial one: the
  // `local-user` admin row is seeded exactly as boot seeded it in the mixed
  // mode, so a rung 5 that fired here would answer with a live admin (200),
  // not merely a 404 on a missing row.
  it("VALET_LOCAL_AUTH=1 next to a real auth instance grants nothing", async () => {
    api = await bootTestApi({ auth: true });
    const { db } = api.providers;

    const signUpRes = await fetch(`${api.baseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "First Admin", email: "first-admin@nowhere.test", password: "correct-horse-battery" }),
    });
    expect(signUpRes.status).toBe(200);
    const adminRows = await db.select().from(users).where(eq(users.email, "first-admin@nowhere.test")).limit(1);
    const admin = adminRows[0];
    expect(admin).toBeDefined();

    await db
      .insert(users)
      .values({ id: "local-user", email: "local@dev", name: "Local Dev", role: "admin" })
      .onConflictDoNothing();

    const prev = process.env.VALET_LOCAL_AUTH;
    process.env.VALET_LOCAL_AUTH = "1";
    try {
      const bareRes = await fetch(`${api.baseUrl}/api/me`);
      expect(bareRes.status).toBe(401);
      expect(await bareRes.json()).toEqual({ error: "unauthorized" });

      // The impersonation header rides on the same rung — it must not reach
      // a real user either.
      const impersonatedRes = await fetch(`${api.baseUrl}/api/me`, {
        headers: { "x-valet-test-user-id": admin!.id },
      });
      expect(impersonatedRes.status).toBe(401);
      expect(await impersonatedRes.json()).toEqual({ error: "unauthorized" });
    } finally {
      if (prev === undefined) delete process.env.VALET_LOCAL_AUTH;
      else process.env.VALET_LOCAL_AUTH = prev;
    }
  });

  it("a malformed x-api-key 401s cleanly instead of 500ing", async () => {
    api = await bootTestApi({ auth: true });
    const res = await fetch(`${api.baseUrl}/api/me`, {
      headers: { "x-api-key": "x".repeat(4096) },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid api key");
  });
});
