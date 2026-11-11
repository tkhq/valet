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
import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import * as authModule from "./index.js";
import { users, invites, ssoProvider } from "../schema/index.js";
import { SSO_ROUTE_REFUSED_MESSAGE } from "./sso-hooks.js";
import { createInvite } from "./invites.js";
import { bootstrapAdminInviteCode } from "../test-helpers/bootstrap-admin-code.js";
import type { AuthConfigResponse } from "../wire/types.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
  vi.unstubAllEnvs();
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

    // A fresh deployment admits no one without an invite: a stranger cannot become the first admin.
    const strangerRes = await fetch(`${api.baseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Stranger", email: "stranger@nowhere.test", password: "correct-horse-battery" }),
    });
    expect(strangerRes.status).toBe(403);

    // The operator's one-time link from the boot log creates the first admin.
    const signUpRes = await fetch(`${api.baseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "First User", email: "first@nowhere.test", password: "correct-horse-battery",
        inviteCode: await bootstrapAdminInviteCode(api.providers.db) }),
    });
    expect(signUpRes.status).toBe(200);
    const cookie = extractSessionCookie(signUpRes.headers.get("set-cookie"));

    const sessionRes = await fetch(`${api.baseUrl}/api/auth/get-session`, {
      headers: { cookie },
    });
    expect(sessionRes.status).toBe(200);
    const sessionBody = (await sessionRes.json()) as { user: { email: string; role: string } };
    expect(sessionBody.user.email).toBe("first@nowhere.test");
    // The bootstrap invite's role (auth-v2 design, decision 5).
    expect(sessionBody.user.role).toBe("admin");

    const configRes = await fetch(`${api.baseUrl}/api/auth-config`);
    expect(configRes.status).toBe(200);
    const configBody = (await configRes.json()) as AuthConfigResponse;
    expect(configBody).toEqual({ stub: false, password: true, primary: "password", social: [], sso: null });
  });

  it("stores sign-in access and refresh tokens encrypted", async () => {
    const buildAuth = authModule.buildAuth;
    let options: ReturnType<typeof buildAuth>["options"] | undefined;
    vi.spyOn(authModule, "buildAuth").mockImplementation((opts) => {
      const auth = buildAuth(opts);
      options = auth.options;
      return auth;
    });
    api = await bootTestApi({ auth: true });
    expect(options?.account?.encryptOAuthTokens).toBe(true);
  });

  it("refuses email sign-up and sign-in when AUTH_METHODS does not list password", async () => {
    vi.stubEnv("AUTH_METHODS", "");
    try {
      api = await bootTestApi({ auth: true });
      const body = JSON.stringify({ name: "Someone", email: "someone@nowhere.test", password: "correct-horse-battery" });
      const headers = { "Content-Type": "application/json" };
      const signUp = await fetch(`${api.baseUrl}/api/auth/sign-up/email`, { method: "POST", headers, body });
      expect(signUp.ok).toBe(false);
      const signIn = await fetch(`${api.baseUrl}/api/auth/sign-in/email`, { method: "POST", headers, body });
      expect(signIn.ok).toBe(false);
      const config = (await (await fetch(`${api.baseUrl}/api/auth-config`)).json()) as AuthConfigResponse;
      expect(config).toEqual({ stub: false, password: false, primary: null, social: [], sso: null });
    } finally {
      // Clean up before unstubbing: cleanup restores the env it saw at boot.
      await api?.cleanup();
      api = undefined;
      vi.unstubAllEnvs();
    }
  });

  it("GET /api/auth-config reports stub:true on a default (stub-only) boot", async () => {
    api = await bootTestApi();

    const res = await fetch(`${api.baseUrl}/api/auth-config`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as AuthConfigResponse;
    expect(body).toEqual({ stub: true, password: false, primary: null, social: [], sso: null });
  });

  it("GET /api/auth-config reports the public origin that generated file links use", async () => {
    vi.stubEnv("VALET_PUBLIC_URL", "https://valet.example.com/app");
    try {
      api = await bootTestApi();
      const body = (await (await fetch(`${api.baseUrl}/api/auth-config`)).json()) as AuthConfigResponse;
      expect(body.publicOrigin).toBe("https://valet.example.com");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it(
    "a code-only invite's inviteCode survives ctx.body into databaseHooks and stamps the invited role, " +
      "accepting the invite — through the real /sign-up/email endpoint, not a synthetic hook call",
    async () => {
      api = await bootTestApi({ auth: true });
      const { db } = api.providers;

      // First user: the operator's bootstrap admin, so the second signup
      // below exercises a code-only invite from an existing admin.
      const firstRes = await fetch(`${api.baseUrl}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Org Admin", email: "org-admin@nowhere.test", password: "correct-horse-battery",
          inviteCode: await bootstrapAdminInviteCode(db) }),
      });
      expect(firstRes.status).toBe(200);
      const firstUserRows = await db.select().from(users).where(eq(users.email, "org-admin@nowhere.test")).limit(1);
      const firstUser = firstUserRows[0];
      expect(firstUser).toBeDefined();

      // Code-only invite: no email target, role "admin" — only a valid
      // `inviteCode` in the signup body can admit it.
      const { invite, code } = await createInvite(db, { role: "admin", createdBy: firstUser!.id });

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

      const invitedUserRows = await db.select().from(users).where(eq(users.email, "invited-admin@nowhere.test")).limit(1);
      const invitedUser = invitedUserRows[0];
      expect(invitedUser).toBeDefined();
      expect(invitedUser?.role).toBe("admin");

      const inviteRows = await db.select().from(invites).where(eq(invites.id, invite.id)).limit(1);
      expect(inviteRows[0]?.acceptedBy).toBe(invitedUser!.id);
    },
  );
});

it("unrestricted signup creates a member without an invitation", async () => {
  vi.stubEnv("AUTH_ALLOW_SIGNUP", "1");
  api = await bootTestApi({ auth: true });
  await api.providers.db.insert(users).values({ id: "existing-admin", email: "owner@example.test", name: "Owner", role: "admin" });
  const response = await fetch(`${api.baseUrl}/api/auth/sign-up/email`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "New member", email: "new@unlisted.test", password: "valid-password-for-test" }),
  });
  expect(response.status).toBe(200);
  const [created] = await api.providers.db.select().from(users).where(eq(users.email, "new@unlisted.test"));
  expect(created?.role).toBe("member");
  const cookie = extractSessionCookie(response.headers.get("set-cookie"));
  const session = await fetch(`${api.baseUrl}/api/auth/get-session`, { headers: { cookie } });
  expect(session.status).toBe(200);
  expect(await session.json()).toMatchObject({ user: { id: created!.id, role: "member" } });
});

it("refuses SSO provider routes and stored providers; allows the configured provider's callback", async () => {
  vi.stubEnv("AUTH_ALLOW_SIGNUP", "1");
  vi.stubEnv("AUTH_METHODS", "password,oidc");
  vi.stubEnv("AUTH_OIDC_ISSUER", "https://idp.example.test/realms/valet");
  vi.stubEnv("AUTH_OIDC_CLIENT_ID", "valet");
  vi.stubEnv("AUTH_OIDC_CLIENT_SECRET", "valet-secret");
  api = await bootTestApi({ auth: true });
  await api.providers.db.insert(users).values({ id: "existing-admin", email: "owner@example.test", name: "Owner", role: "admin" });
  const signUp = await fetch(`${api.baseUrl}/api/auth/sign-up/email`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Member", email: "member@unlisted.test", password: "valid-password-for-test" }),
  });
  expect(signUp.status).toBe(200);
  const cookie = extractSessionCookie(signUp.headers.get("set-cookie"));
  // A provider row that an older image let a member store.
  await api.providers.db.insert(ssoProvider).values({
    id: "stored-1", providerId: "stored", issuer: "https://idp.attacker.test", domain: "attacker.test",
    oidcConfig: JSON.stringify({ clientId: "x", clientSecret: "y", tokenEndpoint: "https://idp.attacker.test/token" }),
  });

  const post = (path: string, body: Record<string, unknown>) => fetch(`${api!.baseUrl}/api/auth${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify(body),
  });
  const refused = [
    await post("/sso/register", {
      providerId: "evil", issuer: "https://idp.attacker.test", domain: "attacker.test",
      oidcConfig: { clientId: "x", clientSecret: "y", skipDiscovery: true, authorizationEndpoint: "https://idp.attacker.test/auth",
        tokenEndpoint: "https://idp.attacker.test/token", jwksEndpoint: "https://idp.attacker.test/jwks" },
    }),
    await post("/sso/update-provider", { providerId: "stored", issuer: "https://idp2.attacker.test" }),
    await fetch(`${api.baseUrl}/api/auth/sso/providers`, { headers: { cookie } }),
    await fetch(`${api.baseUrl}/api/auth/sso/get-provider?providerId=stored`, { headers: { cookie } }),
    await post("/sign-in/sso", { providerId: "stored", callbackURL: "/" }),
    await post("/sign-in/sso", { email: "someone@attacker.test", callbackURL: "/" }),
    await fetch(`${api.baseUrl}/api/auth/sso/callback/stored?code=c&state=s`, { redirect: "manual" }),
  ];
  for (const res of refused) {
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ message: SSO_ROUTE_REFUSED_MESSAGE });
  }
  expect(await api.providers.db.select().from(ssoProvider)).toHaveLength(1);

  // The configured provider's callback reaches the plugin, which rejects the missing state itself.
  const callback = await fetch(`${api.baseUrl}/api/auth/sso/callback/oidc?code=c&state=s`, { redirect: "manual" });
  expect(callback.status).not.toBe(403);
});

it("refuses SSO sign-in when no OIDC provider is configured", async () => {
  api = await bootTestApi({ auth: true });
  const res = await fetch(`${api.baseUrl}/api/auth/sign-in/sso`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ providerId: "oidc", callbackURL: "/" }),
  });
  expect(res.status).toBe(403);
});
