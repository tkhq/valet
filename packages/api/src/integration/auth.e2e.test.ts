/**
 * Full-flow E2E for auth v2 (Task 12) — a real `bootTestApi({ auth: true })`
 * boot, `VALET_LOCAL_AUTH` unset, driving the actual flow a deployment
 * exercises rather than any single subsystem in isolation:
 *
 *   1. Signup #1 (no invite) → admin (first-ever signup rule), verified via
 *      a cookie-authed `GET /api/me`.
 *   2. Signup #2 without an invite → 403 with the exact rejection copy.
 *   3. The admin creates an invite (`POST /api/org/invites`, cookie-authed).
 *   4. Signup #2 retried with the invite code → succeeds as `member`.
 *   5. The admin creates an API key (`POST /api/auth/api-key/create`,
 *      cookie-authed) and a key-authed `GET /api/me` returns the admin.
 *   6. A sandbox token minted directly (`mintSandboxToken`) authenticates a
 *      memory-route call via `x-valet-sandbox`.
 *   7. `GET /.well-known/oauth-authorization-server` serves discovery
 *      metadata.
 *
 * Each of these is unit/integration-tested in isolation elsewhere
 * (auth-instance.test.ts, org-invites.test.ts, auth.ladder.test.ts,
 * sandbox-tokens.test.ts, mcp.test.ts) — this file's job is only to prove
 * they compose into one coherent deployment story.
 */
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { bootTestApi, type TestApi } from "./_setup.js";
import { users } from "../schema/index.js";
import { mintSandboxToken } from "../auth/sandbox-tokens.js";
import type {
  AuthConfigResponse,
  CreateInviteResponse,
  MeResponse,
} from "../wire/types.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

/** Same cookie-extraction approach as auth-instance.test.ts — undici folds
 * multiple `set-cookie` values into one comma-joined header, so this splits
 * on the `better-auth.` cookie-name boundary rather than a bare comma. */
function extractSessionCookie(setCookieHeader: string | null): string {
  expect(setCookieHeader).toBeTruthy();
  const match = setCookieHeader?.match(/better-auth\.session_token=[^;]+/);
  expect(match).toBeTruthy();
  return match![0];
}

describe("auth v2 — end-to-end deployment flow", () => {
  it("signup, invite gate, invited signup, API key, sandbox token, and discovery all compose", async () => {
    api = await bootTestApi({ auth: true });

    // 1. Signup #1 — first-ever signup, no invite needed — is promoted to admin.
    const signUp1Res = await fetch(`${api.baseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "First Admin", email: "admin@nowhere.test", password: "correct-horse-battery" }),
    });
    expect(signUp1Res.status).toBe(200);
    const adminCookie = extractSessionCookie(signUp1Res.headers.get("set-cookie"));

    const adminMeRes = await fetch(`${api.baseUrl}/api/me`, { headers: { cookie: adminCookie } });
    expect(adminMeRes.status).toBe(200);
    const adminMe = (await adminMeRes.json()) as MeResponse;
    expect(adminMe.email).toBe("admin@nowhere.test");
    expect(adminMe.role).toBe("admin");

    // 2. Signup #2 without an invite → 403 with the exact rejection copy.
    const signUp2RejectRes = await fetch(`${api.baseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Second User", email: "member@nowhere.test", password: "correct-horse-battery" }),
    });
    expect(signUp2RejectRes.status).toBe(403);
    const rejectBody = (await signUp2RejectRes.json()) as { message: string };
    expect(rejectBody.message).toBe("an invite is required to join this deployment");

    // 3. Admin creates an invite (cookie-authed).
    const inviteRes = await fetch(`${api.baseUrl}/api/org/invites`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ role: "member" }),
    });
    expect(inviteRes.status).toBe(200);
    const invite = (await inviteRes.json()) as CreateInviteResponse;
    expect(invite.code).toBeTruthy();

    // 4. Signup #2 retried with the invite code → succeeds as member.
    const signUp2Res = await fetch(`${api.baseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Second User",
        email: "member@nowhere.test",
        password: "correct-horse-battery",
        inviteCode: invite.code,
      }),
    });
    expect(signUp2Res.status).toBe(200);
    const memberCookie = extractSessionCookie(signUp2Res.headers.get("set-cookie"));

    const memberMeRes = await fetch(`${api.baseUrl}/api/me`, { headers: { cookie: memberCookie } });
    expect(memberMeRes.status).toBe(200);
    const memberMe = (await memberMeRes.json()) as MeResponse;
    expect(memberMe.email).toBe("member@nowhere.test");
    expect(memberMe.role).toBe("member");

    // 5. Admin creates an API key (cookie-authed) → key-authed GET /api/me
    // returns the admin.
    const createKeyRes = await fetch(`${api.baseUrl}/api/auth/api-key/create`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ name: "e2e-admin-key" }),
    });
    expect(createKeyRes.status).toBe(200);
    const createdKey = (await createKeyRes.json()) as { id: string; key: string };
    expect(createdKey.key).toBeTruthy();

    const keyAuthedMeRes = await fetch(`${api.baseUrl}/api/me`, {
      headers: { "x-api-key": createdKey.key },
    });
    expect(keyAuthedMeRes.status).toBe(200);
    const keyAuthedMe = (await keyAuthedMeRes.json()) as MeResponse;
    expect(keyAuthedMe.email).toBe("admin@nowhere.test");
    expect(keyAuthedMe.role).toBe("admin");

    // 6. Sandbox token minted directly (no HTTP mint endpoint this pass) +
    // a memory-route call authenticates via x-valet-sandbox.
    const { db } = api.providers;
    const adminRow = await db.select().from(users).where(eq(users.email, "admin@nowhere.test")).get();
    expect(adminRow).toBeDefined();

    const { token: sandboxToken } = mintSandboxToken(db, {
      sessionId: "e2e-sandbox-session",
      userId: adminRow!.id,
      orgId: adminMe.orgId,
    });

    const memoryPutRes = await fetch(`${api.baseUrl}/api/memory`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-valet-sandbox": sandboxToken },
      body: JSON.stringify({ path: "notes/e2e.md", content: "hello from the e2e sandbox token" }),
    });
    expect(memoryPutRes.status).toBe(200);

    const memoryGetRes = await fetch(
      `${api.baseUrl}/api/memory?path=${encodeURIComponent("notes/e2e.md")}`,
      { headers: { "x-valet-sandbox": sandboxToken } },
    );
    expect(memoryGetRes.status).toBe(200);
    const memoryBody = (await memoryGetRes.json()) as { rendered?: string };
    expect(memoryBody.rendered).toContain("hello from the e2e sandbox token");

    // 7. Discovery metadata is served.
    const discoveryRes = await fetch(`${api.baseUrl}/.well-known/oauth-authorization-server`);
    expect(discoveryRes.status).toBe(200);
    const discovery = (await discoveryRes.json()) as { issuer: string; authorization_endpoint: string };
    expect(discovery.issuer).toBeTruthy();
    expect(discovery.authorization_endpoint).toBeTruthy();

    // Sanity: real-auth mode reports stub:false throughout.
    const configRes = await fetch(`${api.baseUrl}/api/auth-config`);
    const config = (await configRes.json()) as AuthConfigResponse;
    expect(config.stub).toBe(false);
  });
});
