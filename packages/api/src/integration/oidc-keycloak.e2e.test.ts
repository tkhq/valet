/**
 * Live OIDC code-flow e2e against the dockerized Keycloak (`make
 * dev-keycloak` / the `keycloak` compose profile). Covers the wiring nothing
 * else tests: issuer discovery, the authorize redirect, token exchange at the
 * callback, claim mapping, and domain-based user provisioning — all driven
 * headlessly with fetch + a cookie jar (Keycloak's login page is a plain
 * HTML form; no browser).
 *
 * The imported `valet` realm pins the client's redirect URIs to
 * `http://localhost:8788/api/auth/sso/callback/*` while `bootTestApi` binds a
 * random port — Keycloak's final 302 therefore points at :8788 and the test
 * rewrites the host to the live test port before following it. Only the
 * browser-facing hop is rewritten; the code↔token exchange happens
 * server-side against the real issuer.
 *
 * Skips (does not fail) when the Keycloak realm isn't reachable — `make e2e`
 * boots the container via its `keycloak` pre-hook.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootTestApi, type TestApi } from "./_setup.js";

const KC_ISSUER = "http://localhost:8081/realms/valet";

async function keycloakUp(): Promise<boolean> {
  try {
    const res = await fetch(`${KC_ISSUER}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(3_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const kcUp = await keycloakUp();

/** Minimal per-host cookie jar (no deps). */
class CookieJar {
  private readonly byHost = new Map<string, Map<string, string>>();

  absorb(url: string, res: Response): void {
    const host = new URL(url).host;
    const jar = this.byHost.get(host) ?? new Map<string, string>();
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const eq = pair.indexOf("=");
      if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    this.byHost.set(host, jar);
  }

  header(url: string): string {
    const jar = this.byHost.get(new URL(url).host);
    if (!jar || jar.size === 0) return "";
    return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

describe.skipIf(!kcUp)("OIDC code flow against live Keycloak", () => {
  let api: TestApi;

  beforeAll(async () => {
    process.env.AUTH_OIDC_ISSUER = KC_ISSUER;
    process.env.AUTH_OIDC_CLIENT_ID = "valet";
    process.env.AUTH_OIDC_CLIENT_SECRET = "valet-dev-secret";
    // The realm's seeded users live on valet.test; make that the SSO domain.
    process.env.AUTH_OIDC_DOMAIN = "valet.test";
    // better-auth refuses OIDC discovery against origins outside
    // trustedOrigins ("discovery_untrusted_origin") — trust the local issuer.
    process.env.AUTH_TRUSTED_ORIGINS = "http://localhost:8081";
    api = await bootTestApi({ auth: true });
  }, 60_000);

  afterAll(async () => {
    delete process.env.AUTH_OIDC_ISSUER;
    delete process.env.AUTH_OIDC_CLIENT_ID;
    delete process.env.AUTH_OIDC_CLIENT_SECRET;
    delete process.env.AUTH_OIDC_DOMAIN;
    delete process.env.AUTH_TRUSTED_ORIGINS;
    await api?.cleanup();
  });

  it("signs alice in via the real authorization-code flow", async () => {
    const jar = new CookieJar();

    // 1. Ask better-auth for the authorize redirect.
    const signIn = await fetch(`${api.baseUrl}/api/auth/sign-in/sso`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: "oidc", callbackURL: "/" }),
    });
    if (signIn.status !== 200) {
      throw new Error(`sign-in/sso ${signIn.status}: ${await signIn.text()}`);
    }
    jar.absorb(api.baseUrl, signIn);
    const { url: authorizeUrl } = (await signIn.json()) as { url: string };
    expect(authorizeUrl).toContain("/realms/valet/protocol/openid-connect/auth");

    // 2. Load the Keycloak login page; parse the form action.
    const loginPage = await fetch(authorizeUrl, { redirect: "manual" });
    jar.absorb(authorizeUrl, loginPage);
    const html = await loginPage.text();
    const action = /action="([^"]+)"/.exec(html)?.[1]?.replace(/&amp;/g, "&");
    if (!action) throw new Error(`no login form action in Keycloak page:\n${html.slice(0, 500)}`);

    // 3. Submit the seeded credentials.
    const login = await fetch(action, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        cookie: jar.header(action),
      },
      body: new URLSearchParams({
        username: "alice@valet.test",
        password: "password",
      }).toString(),
      redirect: "manual",
    });
    jar.absorb(action, login);
    expect(login.status).toBe(302);
    const kcRedirect = login.headers.get("location");
    if (!kcRedirect) throw new Error("keycloak login did not redirect");

    // 4. Follow the callback — rewriting the realm's pinned :8788 host to the
    // live test port (see file header).
    const callback = new URL(kcRedirect);
    const testBase = new URL(api.baseUrl);
    callback.protocol = testBase.protocol;
    callback.host = testBase.host;
    const cb = await fetch(callback.toString(), {
      headers: { cookie: jar.header(api.baseUrl) },
      redirect: "manual",
    });
    jar.absorb(api.baseUrl, cb);
    expect([302, 303]).toContain(cb.status);

    // 5. The api session is live: /api/me returns alice.
    const me = await fetch(`${api.baseUrl}/api/me`, {
      headers: { cookie: jar.header(api.baseUrl) },
    });
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as { email: string; orgId: string };
    expect(meBody.email).toBe("alice@valet.test");
    // Domain-based provisioning ran: alice landed in an org.
    expect(meBody.orgId).toBeTruthy();
  }, 60_000);
});

if (!kcUp) {
  // eslint-disable-next-line no-console
  console.log("[oidc-keycloak.e2e] skipped: Keycloak realm not reachable on :8081 (make dev-keycloak)");
}
