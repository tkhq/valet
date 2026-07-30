/**
 * Tests for auth configuration loader.
 * Validates that environment variables are properly parsed into AuthConfig
 * with correct defaults, validations, and error cases.
 */
import { describe, it, expect } from "vitest";
import { loadAuthConfig } from "./config.js";

describe("loadAuthConfig", () => {
  // Stub-only mode: no BETTER_AUTH_SECRET
  it("returns null when BETTER_AUTH_SECRET is not set", () => {
    const result = loadAuthConfig({});
    expect(result).toBeNull();
  });

  it("returns null when BETTER_AUTH_SECRET is an empty string", () => {
    const result = loadAuthConfig({ BETTER_AUTH_SECRET: "" });
    expect(result).toBeNull();
  });

  // Minimal config: secret only
  it("returns minimal config with just BETTER_AUTH_SECRET", () => {
    const result = loadAuthConfig({ BETTER_AUTH_SECRET: "test-secret" });

    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      secret: "test-secret",
      baseUrl: "http://localhost:8788",
      trustedOrigins: ["http://localhost:5173"],
      allowedEmailDomains: [],
      social: {},
      sandboxJwtMaster: "test-secret",
    });
    expect(result?.oidc).toBeUndefined();
  });

  // baseUrl from BETTER_AUTH_URL
  it("uses BETTER_AUTH_URL when set", () => {
    const result = loadAuthConfig({
      BETTER_AUTH_SECRET: "secret",
      BETTER_AUTH_URL: "https://auth.example.com",
    });

    expect(result?.baseUrl).toBe("https://auth.example.com");
  });

  // trustedOrigins parsing
  it("includes http://localhost:5173 in trustedOrigins always", () => {
    const result = loadAuthConfig({ BETTER_AUTH_SECRET: "secret" });
    expect(result?.trustedOrigins).toContain("http://localhost:5173");
  });

  it("appends AUTH_TRUSTED_ORIGINS when set", () => {
    const result = loadAuthConfig({
      BETTER_AUTH_SECRET: "secret",
      AUTH_TRUSTED_ORIGINS: "https://app.example.com, https://web.example.com",
    });

    expect(result?.trustedOrigins).toContain("http://localhost:5173");
    expect(result?.trustedOrigins).toContain("https://app.example.com");
    expect(result?.trustedOrigins).toContain("https://web.example.com");
  });

  it("trims whitespace from AUTH_TRUSTED_ORIGINS", () => {
    const result = loadAuthConfig({
      BETTER_AUTH_SECRET: "secret",
      AUTH_TRUSTED_ORIGINS: "  https://app.example.com  ,  https://web.example.com  ",
    });

    expect(result?.trustedOrigins).toEqual([
      "http://localhost:5173",
      "https://app.example.com",
      "https://web.example.com",
    ]);
  });

  // allowedEmailDomains parsing
  it("returns empty allowedEmailDomains when unset", () => {
    const result = loadAuthConfig({ BETTER_AUTH_SECRET: "secret" });
    expect(result?.allowedEmailDomains).toEqual([]);
  });

  it("parses and lowercases AUTH_ALLOWED_EMAIL_DOMAINS", () => {
    const result = loadAuthConfig({
      BETTER_AUTH_SECRET: "secret",
      AUTH_ALLOWED_EMAIL_DOMAINS: "Example.com, FOO.dev",
    });

    expect(result?.allowedEmailDomains).toEqual(["example.com", "foo.dev"]);
  });

  it("trims whitespace from AUTH_ALLOWED_EMAIL_DOMAINS", () => {
    const result = loadAuthConfig({
      BETTER_AUTH_SECRET: "secret",
      AUTH_ALLOWED_EMAIL_DOMAINS: "  example.com  ,  foo.dev  ",
    });

    expect(result?.allowedEmailDomains).toEqual(["example.com", "foo.dev"]);
  });

  // OIDC configuration
  it("returns undefined oidc when none of the env vars are set", () => {
    const result = loadAuthConfig({ BETTER_AUTH_SECRET: "secret" });
    expect(result?.oidc).toBeUndefined();
  });

  it("requires all three OIDC env vars: issuer, clientId, clientSecret", () => {
    let thrownMessage = "";
    try {
      loadAuthConfig({
        BETTER_AUTH_SECRET: "secret",
        AUTH_OIDC_ISSUER: "https://oidc.example.com",
      });
    } catch (e) {
      thrownMessage = (e as Error).message;
    }

    // Should name only the missing vars, not the ones that ARE set
    expect(thrownMessage).toContain("AUTH_OIDC_CLIENT_ID");
    expect(thrownMessage).toContain("AUTH_OIDC_CLIENT_SECRET");
    expect(thrownMessage).not.toContain("AUTH_OIDC_ISSUER");
  });

  it("throws when OIDC issuer and clientSecret are set but clientId is missing", () => {
    let thrownMessage = "";
    try {
      loadAuthConfig({
        BETTER_AUTH_SECRET: "secret",
        AUTH_OIDC_ISSUER: "https://oidc.example.com",
        AUTH_OIDC_CLIENT_SECRET: "secret",
      });
    } catch (e) {
      thrownMessage = (e as Error).message;
    }

    expect(thrownMessage).toContain("AUTH_OIDC_CLIENT_ID");
    expect(thrownMessage).not.toContain("AUTH_OIDC_ISSUER");
    expect(thrownMessage).not.toContain("AUTH_OIDC_CLIENT_SECRET");
  });

  it("throws when OIDC issuer and clientId are set but clientSecret is missing", () => {
    let thrownMessage = "";
    try {
      loadAuthConfig({
        BETTER_AUTH_SECRET: "secret",
        AUTH_OIDC_ISSUER: "https://oidc.example.com",
        AUTH_OIDC_CLIENT_ID: "client-id",
      });
    } catch (e) {
      thrownMessage = (e as Error).message;
    }

    expect(thrownMessage).toContain("AUTH_OIDC_CLIENT_SECRET");
    expect(thrownMessage).not.toContain("AUTH_OIDC_ISSUER");
    expect(thrownMessage).not.toContain("AUTH_OIDC_CLIENT_ID");
  });

  it("names only missing OIDC vars in error message", () => {
    let thrownMessage = "";
    try {
      loadAuthConfig({
        BETTER_AUTH_SECRET: "secret",
        AUTH_OIDC_ISSUER: "https://oidc.example.com",
        AUTH_OIDC_CLIENT_ID: "client-id",
        // clientSecret is missing
      });
    } catch (e) {
      thrownMessage = (e as Error).message;
    }

    expect(thrownMessage).toContain("AUTH_OIDC_CLIENT_SECRET");
    expect(thrownMessage).not.toContain("AUTH_OIDC_ISSUER");
    expect(thrownMessage).not.toContain("AUTH_OIDC_CLIENT_ID");
  });

  it("populates OIDC config when all three required vars are set", () => {
    const result = loadAuthConfig({
      BETTER_AUTH_SECRET: "secret",
      AUTH_OIDC_ISSUER: "https://oidc.example.com",
      AUTH_OIDC_CLIENT_ID: "client-id",
      AUTH_OIDC_CLIENT_SECRET: "client-secret",
    });

    expect(result?.oidc).toMatchObject({
      issuer: "https://oidc.example.com",
      clientId: "client-id",
      clientSecret: "client-secret",
      name: "SSO", // default
      domain: "oidc.example.com", // from issuer hostname
      roleClaim: "realm_access.roles", // default
    });
  });

  it("uses AUTH_OIDC_NAME when set, otherwise defaults to SSO", () => {
    const withName = loadAuthConfig({
      BETTER_AUTH_SECRET: "secret",
      AUTH_OIDC_ISSUER: "https://oidc.example.com",
      AUTH_OIDC_CLIENT_ID: "client-id",
      AUTH_OIDC_CLIENT_SECRET: "client-secret",
      AUTH_OIDC_NAME: "Corporate SSO",
    });

    expect(withName?.oidc?.name).toBe("Corporate SSO");

    const withoutName = loadAuthConfig({
      BETTER_AUTH_SECRET: "secret",
      AUTH_OIDC_ISSUER: "https://oidc.example.com",
      AUTH_OIDC_CLIENT_ID: "client-id",
      AUTH_OIDC_CLIENT_SECRET: "client-secret",
    });

    expect(withoutName?.oidc?.name).toBe("SSO");
  });

  it("extracts hostname from issuer URL as default domain", () => {
    const result = loadAuthConfig({
      BETTER_AUTH_SECRET: "secret",
      AUTH_OIDC_ISSUER: "https://oidc.example.com:8443/auth",
      AUTH_OIDC_CLIENT_ID: "client-id",
      AUTH_OIDC_CLIENT_SECRET: "client-secret",
    });

    expect(result?.oidc?.domain).toBe("oidc.example.com");
  });

  it("uses AUTH_OIDC_DOMAIN when set, ignoring issuer hostname", () => {
    const result = loadAuthConfig({
      BETTER_AUTH_SECRET: "secret",
      AUTH_OIDC_ISSUER: "https://oidc.example.com",
      AUTH_OIDC_CLIENT_ID: "client-id",
      AUTH_OIDC_CLIENT_SECRET: "client-secret",
      AUTH_OIDC_DOMAIN: "custom.domain.com",
    });

    expect(result?.oidc?.domain).toBe("custom.domain.com");
  });

  // Google OAuth configuration
  it("does not include google when neither clientId nor clientSecret are set", () => {
    const result = loadAuthConfig({ BETTER_AUTH_SECRET: "secret" });
    expect(result?.social.google).toBeUndefined();
  });

  it("throws when Google clientId is set but clientSecret is missing", () => {
    expect(() =>
      loadAuthConfig({
        BETTER_AUTH_SECRET: "secret",
        AUTH_GOOGLE_CLIENT_ID: "google-id",
      })
    ).toThrow(/AUTH_GOOGLE_CLIENT_SECRET/);
  });

  it("throws when Google clientSecret is set but clientId is missing", () => {
    expect(() =>
      loadAuthConfig({
        BETTER_AUTH_SECRET: "secret",
        AUTH_GOOGLE_CLIENT_SECRET: "google-secret",
      })
    ).toThrow(/AUTH_GOOGLE_CLIENT_ID/);
  });

  it("includes google config when both clientId and clientSecret are set", () => {
    const result = loadAuthConfig({
      BETTER_AUTH_SECRET: "secret",
      AUTH_GOOGLE_CLIENT_ID: "google-id",
      AUTH_GOOGLE_CLIENT_SECRET: "google-secret",
    });

    expect(result?.social.google).toEqual({
      clientId: "google-id",
      clientSecret: "google-secret",
    });
  });

  // GitHub OAuth configuration
  it("does not include github when neither clientId nor clientSecret are set", () => {
    const result = loadAuthConfig({ BETTER_AUTH_SECRET: "secret" });
    expect(result?.social.github).toBeUndefined();
  });

  it("throws when GitHub clientId is set but clientSecret is missing", () => {
    expect(() =>
      loadAuthConfig({
        BETTER_AUTH_SECRET: "secret",
        AUTH_GITHUB_CLIENT_ID: "github-id",
      })
    ).toThrow(/AUTH_GITHUB_CLIENT_SECRET/);
  });

  it("throws when GitHub clientSecret is set but clientId is missing", () => {
    expect(() =>
      loadAuthConfig({
        BETTER_AUTH_SECRET: "secret",
        AUTH_GITHUB_CLIENT_SECRET: "github-secret",
      })
    ).toThrow(/AUTH_GITHUB_CLIENT_ID/);
  });

  it("includes github config when both clientId and clientSecret are set", () => {
    const result = loadAuthConfig({
      BETTER_AUTH_SECRET: "secret",
      AUTH_GITHUB_CLIENT_ID: "github-id",
      AUTH_GITHUB_CLIENT_SECRET: "github-secret",
    });

    expect(result?.social.github).toEqual({
      clientId: "github-id",
      clientSecret: "github-secret",
    });
  });

  // sandboxJwtMaster
  it("defaults sandboxJwtMaster to secret when VALET_SANDBOX_JWT_MASTER is not set", () => {
    const result = loadAuthConfig({ BETTER_AUTH_SECRET: "my-secret" });
    expect(result?.sandboxJwtMaster).toBe("my-secret");
  });

  it("uses VALET_SANDBOX_JWT_MASTER when set", () => {
    const result = loadAuthConfig({
      BETTER_AUTH_SECRET: "my-secret",
      VALET_SANDBOX_JWT_MASTER: "sandbox-master-key",
    });

    expect(result?.sandboxJwtMaster).toBe("sandbox-master-key");
  });

  // Integration tests: multiple configs together
  it("builds full config with all providers and options", () => {
    const result = loadAuthConfig({
      BETTER_AUTH_SECRET: "secret",
      BETTER_AUTH_URL: "https://auth.example.com",
      AUTH_TRUSTED_ORIGINS: "https://app.example.com",
      AUTH_ALLOWED_EMAIL_DOMAINS: "example.com, corp.example.com",
      AUTH_OIDC_ISSUER: "https://oidc.example.com",
      AUTH_OIDC_CLIENT_ID: "oidc-id",
      AUTH_OIDC_CLIENT_SECRET: "oidc-secret",
      AUTH_OIDC_NAME: "Corporate SSO",
      AUTH_OIDC_DOMAIN: "corp.example.com",
      AUTH_GOOGLE_CLIENT_ID: "google-id",
      AUTH_GOOGLE_CLIENT_SECRET: "google-secret",
      AUTH_GITHUB_CLIENT_ID: "github-id",
      AUTH_GITHUB_CLIENT_SECRET: "github-secret",
      VALET_SANDBOX_JWT_MASTER: "sandbox-key",
    });

    expect(result).toEqual({
      secret: "secret",
      baseUrl: "https://auth.example.com",
      trustedOrigins: ["http://localhost:5173", "https://app.example.com"],
      allowedEmailDomains: ["example.com", "corp.example.com"],
      oidc: {
        issuer: "https://oidc.example.com",
        clientId: "oidc-id",
        clientSecret: "oidc-secret",
        name: "Corporate SSO",
        domain: "corp.example.com",
        roleClaim: "realm_access.roles",
      },
      social: {
        google: {
          clientId: "google-id",
          clientSecret: "google-secret",
        },
        github: {
          clientId: "github-id",
          clientSecret: "github-secret",
        },
      },
      sandboxJwtMaster: "sandbox-key",
    });
  });

  // OIDC role-map configuration
  const baseOidcEnv = {
    BETTER_AUTH_SECRET: "secret",
    AUTH_OIDC_ISSUER: "https://oidc.example.com",
    AUTH_OIDC_CLIENT_ID: "client-id",
    AUTH_OIDC_CLIENT_SECRET: "client-secret",
  };

  it("parses AUTH_OIDC_ROLE_MAP preserving order and AUTH_OIDC_ROLE_CLAIM default", () => {
    const cfg = loadAuthConfig({
      ...baseOidcEnv,
      AUTH_OIDC_ROLE_MAP: "valet-admin:admin, valet-operator:operator",
    });
    expect(cfg?.oidc?.roleMap).toEqual([
      { claimValue: "valet-admin", role: "admin" },
      { claimValue: "valet-operator", role: "operator" },
    ]);
    expect(cfg?.oidc?.roleClaim).toBe("realm_access.roles");
  });

  it("honors AUTH_OIDC_ROLE_CLAIM override", () => {
    const cfg = loadAuthConfig({
      ...baseOidcEnv,
      AUTH_OIDC_ROLE_MAP: "x:member",
      AUTH_OIDC_ROLE_CLAIM: "resource_access.valet.roles",
    });
    expect(cfg?.oidc?.roleClaim).toBe("resource_access.valet.roles");
  });

  it("throws on an unknown role in the map", () => {
    expect(() =>
      loadAuthConfig({ ...baseOidcEnv, AUTH_OIDC_ROLE_MAP: "x:owner" })
    ).toThrow(/AUTH_OIDC_ROLE_MAP/);
  });

  it("throws on a malformed pair", () => {
    expect(() =>
      loadAuthConfig({ ...baseOidcEnv, AUTH_OIDC_ROLE_MAP: "justoneword" })
    ).toThrow(/AUTH_OIDC_ROLE_MAP/);
  });

  it("throws when ROLE_MAP is set without OIDC configured", () => {
    expect(() =>
      loadAuthConfig({ BETTER_AUTH_SECRET: "s", AUTH_OIDC_ROLE_MAP: "x:admin" })
    ).toThrow(/AUTH_OIDC_ROLE_MAP/);
  });

  it("does not include roleMap and roleClaim when OIDC is not configured", () => {
    const cfg = loadAuthConfig({ BETTER_AUTH_SECRET: "secret" });
    expect(cfg?.oidc).toBeUndefined();
  });
});
