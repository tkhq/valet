/**
 * `/api/org/invites` — org-admin only. Same gating pattern as
 * `routes/org.test.ts`.
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import type { CreateInviteResponse, ListInvitesResponse } from "../wire/types.js";

const HEADERS = { "Content-Type": "application/json" };
const MEMBER_HEADERS = { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" };

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

describe("POST /api/org/invites", () => {
  it("403s for a non-admin org member", async () => {
    api = await bootTestApi();

    const res = await fetch(`${api.baseUrl}/api/org/invites`, {
      method: "POST",
      headers: MEMBER_HEADERS,
      body: JSON.stringify({ role: "member" }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("org admin required");
  });

  it("creates an invite as admin, returns the code once", async () => {
    api = await bootTestApi();

    const res = await fetch(`${api.baseUrl}/api/org/invites`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ email: "new@example.com", role: "member" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as CreateInviteResponse;
    expect(body.code).toMatch(/^[0-9a-f]{32}$/);
    expect(body.email).toBe("new@example.com");
    expect(body.role).toBe("member");
    expect(typeof body.expiresAt).toBe("number");
    expect(typeof body.id).toBe("string");
  });

  it("401s without auth configured", async () => {
    api = await bootTestApi();
    const prev = process.env.VALET_LOCAL_AUTH;
    process.env.VALET_LOCAL_AUTH = "0";
    try {
      const res = await fetch(`${api.baseUrl}/api/org/invites`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ role: "member" }),
      });
      expect(res.status).toBe(401);
    } finally {
      process.env.VALET_LOCAL_AUTH = prev;
    }
  });
});

describe("GET /api/org/invites", () => {
  it("403s for a non-admin org member", async () => {
    api = await bootTestApi();

    const res = await fetch(`${api.baseUrl}/api/org/invites`, { headers: MEMBER_HEADERS });
    expect(res.status).toBe(403);
  });

  it("lists pending invites with no code anywhere in the payload", async () => {
    api = await bootTestApi();

    const createRes = await fetch(`${api.baseUrl}/api/org/invites`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ role: "admin" }),
    });
    const created = (await createRes.json()) as CreateInviteResponse;

    const res = await fetch(`${api.baseUrl}/api/org/invites`, { headers: HEADERS });
    expect(res.status).toBe(200);
    const bodyText = await res.text();
    expect(bodyText).not.toContain(created.code);

    const body = JSON.parse(bodyText) as ListInvitesResponse;
    expect(body.invites).toHaveLength(1);
    expect(body.invites[0]).toMatchObject({ id: created.id, role: "admin" });
  });
});

describe("DELETE /api/org/invites/:id", () => {
  it("403s for a non-admin org member", async () => {
    api = await bootTestApi();

    const res = await fetch(`${api.baseUrl}/api/org/invites/nonexistent`, {
      method: "DELETE",
      headers: MEMBER_HEADERS,
    });
    expect(res.status).toBe(403);
  });

  it("revokes an invite as admin", async () => {
    api = await bootTestApi();

    const createRes = await fetch(`${api.baseUrl}/api/org/invites`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ role: "member" }),
    });
    const created = (await createRes.json()) as CreateInviteResponse;

    const delRes = await fetch(`${api.baseUrl}/api/org/invites/${created.id}`, {
      method: "DELETE",
      headers: HEADERS,
    });
    expect(delRes.status).toBe(200);
    expect(await delRes.json()).toEqual({ ok: true });

    const listRes = await fetch(`${api.baseUrl}/api/org/invites`, { headers: HEADERS });
    const listBody = (await listRes.json()) as ListInvitesResponse;
    expect(listBody.invites.find((i) => i.id === created.id)).toBeUndefined();
  });

  it("404s revoking an invite that doesn't exist", async () => {
    api = await bootTestApi();

    const res = await fetch(`${api.baseUrl}/api/org/invites/nonexistent`, {
      method: "DELETE",
      headers: HEADERS,
    });
    expect(res.status).toBe(404);
  });
});
