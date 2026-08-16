/**
 * `POST /api/sessions/:id/decisions/:gateId/resolve` — the route-level
 * `always_allow` admin gate (action-policies plan, Task 4). Defense-in-depth
 * front half: `policies/service.ts`'s `writeAlwaysAllowPolicy` already fails
 * a non-admin resolution closed (`AlwaysAllowNotAdminError`, T3), but only
 * AFTER the engine has consumed the gate. This route rejects a non-admin's
 * `always_allow` submission before it ever reaches the engine/gate lookup —
 * placed ahead of the "gate is pending" check below, so it 403s even for a
 * bogus/nonexistent gateId, which is what these tests exercise (no real
 * decision gate needs to exist for the 403 case).
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import type { CreateSessionResponse } from "../wire/types.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

async function createSession(baseUrl: string, headers?: Record<string, string>): Promise<string> {
  const res = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ workspace: "/tmp" }),
  });
  expect(res.status).toBe(201);
  const { id } = (await res.json()) as CreateSessionResponse;
  return id;
}

describe("POST /decisions/:gateId/resolve — always_allow admin gate", () => {
  it("403s for a non-admin resolver, before the gate-pending lookup (bogus gateId still 403s)", async () => {
    api = await bootTestApi();
    // test-member is seeded as a non-admin org member — see _setup.ts.
    const memberHeaders = { "x-valet-test-user-id": "test-member" };
    const sessionId = await createSession(api.baseUrl, memberHeaders);

    const res = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/decisions/nonexistent-gate/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...memberHeaders },
      body: JSON.stringify({ actionId: "always_allow" }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "org admin required for always_allow" });
  });

  it("does not 403 an admin resolver on always_allow (falls through to the gate-pending 404)", async () => {
    api = await bootTestApi();
    // local-user is the seeded org admin — see _setup.ts.
    const sessionId = await createSession(api.baseUrl);

    const res = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/decisions/nonexistent-gate/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actionId: "always_allow" }),
    });
    // Admin clears the always_allow gate — falls through to the ordinary
    // "gate not pending" 404 (no real gate exists in this test), proving
    // the 403 is specifically the non-admin path, not a blanket block.
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "gate not pending" });
  });

  it("does not gate a plain actionId (only always_allow triggers the admin check)", async () => {
    api = await bootTestApi();
    const memberHeaders = { "x-valet-test-user-id": "test-member" };
    const sessionId = await createSession(api.baseUrl, memberHeaders);

    const res = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/decisions/nonexistent-gate/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...memberHeaders },
      body: JSON.stringify({ actionId: "approve" }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "gate not pending" });
  });
});
