/**
 * POST /api/sessions/:id/sandbox-jwt (Task 8, auth-v2 plan) — mints a
 * short-lived service JWT for the session's sandbox to call back into the
 * API. Owner-gated like every other `/api/sessions/:id` route: unknown or
 * not-owned session ids 404 rather than leaking existence.
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { deriveSandboxJwtSecret, verifySandboxJwt } from "../auth/sandbox-tokens.js";
import { internalToken } from "../lib/internal-auth.js";
import { agentSessions } from "../schema/index.js";
import type { SandboxJwtResponse } from "../wire/types.js";
import { verifyGatewayJwt } from "@valet/sandbox-gateway";

describe("POST /api/sessions/:id/sandbox-jwt", () => {
  let api: TestApi | undefined;

  afterEach(async () => {
    await api?.cleanup();
    api = undefined;
  });

  it("mints a JWT the caller can verify against the derived per-session secret (stub mode master)", async () => {
    api = await bootTestApi();
    const { db } = api.providers;
    const now = Date.now();
    await db
      .insert(agentSessions)
      .values({
        id: "sbjwt-session-1",
        userId: "local-user",
        orgId: "local-org",
        workspace: "/tmp/sbjwt-session-1",
        status: "active",
        ownerType: "user",
        ownerId: "local-user",
        createdAt: now,
        updatedAt: now,
      });

    const res = await fetch(`${api.baseUrl}/api/sessions/sbjwt-session-1/sandbox-jwt`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SandboxJwtResponse;
    expect(typeof body.token).toBe("string");
    expect(typeof body.expiresAt).toBe("number");

    const secret = deriveSandboxJwtSecret(internalToken(), "sbjwt-session-1");
    const verified = verifySandboxJwt(secret, body.token);
    expect(verified).toEqual({ sub: "local-user", sid: "sbjwt-session-1" });

    // Two-package contract (Task 6, sandbox auth gateway plan): the exact
    // same api-minted token must also verify via `@valet/sandbox-gateway`'s
    // own verifier — that's what the in-sandbox gateway daemon runs, signed
    // with the same `deriveSandboxJwtSecret`-derived secret it gets handed
    // as `VALET_SANDBOX_JWT_SECRET`.
    const gatewayVerified = verifyGatewayJwt(secret, body.token, "sbjwt-session-1");
    expect(gatewayVerified).toEqual({ sub: "local-user", sid: "sbjwt-session-1" });

    // Rejected for the wrong sid — proves the gateway verifier enforces
    // session binding, not just signature/expiry.
    expect(verifyGatewayJwt(secret, body.token, "some-other-session")).toBeNull();
  });

  it("404s for a session owned by a different user", async () => {
    api = await bootTestApi();
    const { db } = api.providers;
    const now = Date.now();
    await db
      .insert(agentSessions)
      .values({
        id: "sbjwt-session-2",
        userId: "test-member",
        orgId: "local-org",
        workspace: "/tmp/sbjwt-session-2",
        status: "active",
        ownerType: "user",
        ownerId: "test-member",
        createdAt: now,
        updatedAt: now,
      });

    const res = await fetch(`${api.baseUrl}/api/sessions/sbjwt-session-2/sandbox-jwt`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("404s for an unknown session id", async () => {
    api = await bootTestApi();

    const res = await fetch(`${api.baseUrl}/api/sessions/does-not-exist/sandbox-jwt`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});
