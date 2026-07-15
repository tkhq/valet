/**
 * Integration tests for the real better-auth instance + mounting (Task 6):
 *
 *   - `bootTestApi({ auth: true })` wires a real `betterAuth()` instance
 *     under `/api/auth/*`, public (mounted before `authMiddleware`).
 *   - `GET /api/auth-config` reports `{ stub: false, ... }` in real-auth
 *     mode, `{ stub: true, ... }` in the default stub-only boot.
 *   - The signup invite gate + admission-rule role stamping (Task 5) work
 *     end to end through the REAL better-auth `/sign-up/email` endpoint,
 *     not just the unit-level `buildAuthHooks` calls in provisioning.test.ts
 *     — specifically, that `ctx.body`'s `inviteCode` survives into the
 *     `databaseHooks.user.create.before` layer for a code-only invite.
 */
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { users, invites } from "../schema/index.js";
import { createInvite } from "./invites.js";
import type { AuthConfigResponse } from "../wire/types.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

/** Pulls the `better-auth.session_token` cookie pair out of a `set-cookie`
 * header for replay on a follow-up request — undici's fetch folds multiple
 * `set-cookie` values into one comma-joined header, so this splits on the
 * `better-auth.` cookie-name boundary rather than a bare comma (commas also
 * appear inside `Expires=` attribute values). */
function extractSessionCookie(setCookieHeader: string | null): string {
  expect(setCookieHeader).toBeTruthy();
  const match = setCookieHeader?.match(/better-auth\.session_token=[^;]+/);
  expect(match).toBeTruthy();
  return match![0];
}

describe("real better-auth instance + mounting", () => {
  it("signup, session replay, and role stamping work through the real endpoints", async () => {
    api = await bootTestApi({ auth: true });

    const signUpRes = await fetch(`${api.baseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "First User", email: "first@nowhere.test", password: "correct-horse-battery" }),
    });
    expect(signUpRes.status).toBe(200);
    const cookie = extractSessionCookie(signUpRes.headers.get("set-cookie"));

    const sessionRes = await fetch(`${api.baseUrl}/api/auth/get-session`, {
      headers: { cookie },
    });
    expect(sessionRes.status).toBe(200);
    const sessionBody = (await sessionRes.json()) as { user: { email: string; role: string } };
    expect(sessionBody.user.email).toBe("first@nowhere.test");
    // First-ever signup is promoted to admin (auth-v2 design, decision 5).
    expect(sessionBody.user.role).toBe("admin");

    const configRes = await fetch(`${api.baseUrl}/api/auth-config`);
    expect(configRes.status).toBe(200);
    const configBody = (await configRes.json()) as AuthConfigResponse;
    expect(configBody).toEqual({ stub: false, social: [], sso: null });
  });

  it("GET /api/auth-config reports stub:true on a default (stub-only) boot", async () => {
    api = await bootTestApi();

    const res = await fetch(`${api.baseUrl}/api/auth-config`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as AuthConfigResponse;
    expect(body).toEqual({ stub: true, social: [], sso: null });
  });

  it(
    "a code-only invite's inviteCode survives ctx.body into databaseHooks and stamps the invited role, " +
      "accepting the invite — through the real /sign-up/email endpoint, not a synthetic hook call",
    async () => {
      api = await bootTestApi({ auth: true });
      const { db } = api.providers;

      // First user: consumes the "first signup is admin" rule so the
      // second signup below actually exercises the invite path.
      const firstRes = await fetch(`${api.baseUrl}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Org Admin", email: "org-admin@nowhere.test", password: "correct-horse-battery" }),
      });
      expect(firstRes.status).toBe(200);
      const firstUser = await db.select().from(users).where(eq(users.email, "org-admin@nowhere.test")).get();
      expect(firstUser).toBeDefined();

      // Code-only invite: no email target, role "admin" — only a valid
      // `inviteCode` in the signup body can admit it.
      const { invite, code } = createInvite(db, { role: "admin", createdBy: firstUser!.id });

      const signUpRes = await fetch(`${api.baseUrl}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Invited Admin",
          email: "invited-admin@nowhere.test",
          password: "correct-horse-battery",
          inviteCode: code,
        }),
      });
      expect(signUpRes.status).toBe(200);

      const invitedUser = await db.select().from(users).where(eq(users.email, "invited-admin@nowhere.test")).get();
      expect(invitedUser).toBeDefined();
      expect(invitedUser?.role).toBe("admin");

      const inviteRow = await db.select().from(invites).where(eq(invites.id, invite.id)).get();
      expect(inviteRow?.acceptedBy).toBe(invitedUser!.id);
    },
  );
});
