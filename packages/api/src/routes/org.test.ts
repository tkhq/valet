/**
 * `/api/org` + `/api/org/members` — settings-shell org surface
 * (split-settings design). Gate semantics per the spec:
 *   - GET /api/org: any org member.
 *   - PATCH /api/org: org admin only. Always reachable regardless of the
 *     `organizations` feature gate — it's the gate's own toggle.
 *   - GET/PATCH /api/org/members/*: org admin AND the gate must be on;
 *     off => 404 `{error:"organizations not enabled"}` even for admins.
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { LAST_ADMIN_ERROR, SSO_TEAM_GROUP_SHAPE_ERROR } from "../services/org.js";
import type { OrgMembersResponse, OrgResponse } from "../wire/types.js";

const HEADERS = { "Content-Type": "application/json" };
const MEMBER_HEADERS = { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" };

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

async function enableGate(baseUrl: string) {
  const res = await fetch(`${baseUrl}/api/org`, {
    method: "PATCH",
    headers: HEADERS,
    body: JSON.stringify({ features: { organizations: true } }),
  });
  expect(res.status).toBe(200);
}

describe("GET /api/org", () => {
  it("is reachable by any org member, callerRole reflects org_members.role", async () => {
    api = await bootTestApi();

    const adminRes = await fetch(`${api.baseUrl}/api/org`, { headers: HEADERS });
    expect(adminRes.status).toBe(200);
    const adminBody = (await adminRes.json()) as OrgResponse;
    expect(adminBody).toMatchObject({
      id: "local-org",
      name: "Local Dev",
      callerRole: "admin",
      features: { organizations: false },
    });
    expect(typeof adminBody.createdAt).toBe("number");

    const memberRes = await fetch(`${api.baseUrl}/api/org`, { headers: MEMBER_HEADERS });
    expect(memberRes.status).toBe(200);
    const memberBody = (await memberRes.json()) as OrgResponse;
    expect(memberBody.callerRole).toBe("member");
  });

  it("401s without auth configured", async () => {
    api = await bootTestApi();
    const prev = process.env.VALET_LOCAL_AUTH;
    process.env.VALET_LOCAL_AUTH = "0";
    try {
      const res = await fetch(`${api.baseUrl}/api/org`);
      expect(res.status).toBe(401);
    } finally {
      process.env.VALET_LOCAL_AUTH = prev;
    }
  });
});

describe("PATCH /api/org", () => {
  it("403s for a non-admin org member", async () => {
    api = await bootTestApi();

    const res = await fetch(`${api.baseUrl}/api/org`, {
      method: "PATCH",
      headers: MEMBER_HEADERS,
      body: JSON.stringify({ name: "New Name" }),
    });
    expect(res.status).toBe(403);
  });

  it("renames the org", async () => {
    api = await bootTestApi();

    const res = await fetch(`${api.baseUrl}/api/org`, {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ name: "Acme Corp" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OrgResponse;
    expect(body.name).toBe("Acme Corp");

    const getRes = await fetch(`${api.baseUrl}/api/org`, { headers: HEADERS });
    const getBody = (await getRes.json()) as OrgResponse;
    expect(getBody.name).toBe("Acme Corp");
  });

  it("flips the organizations feature gate as admin and GET reflects it", async () => {
    api = await bootTestApi();

    const res = await fetch(`${api.baseUrl}/api/org`, {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ features: { organizations: true } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OrgResponse;
    expect(body.features.organizations).toBe(true);

    const getRes = await fetch(`${api.baseUrl}/api/org`, { headers: HEADERS });
    const getBody = (await getRes.json()) as OrgResponse;
    expect(getBody.features.organizations).toBe(true);
  });

  it("rejects unknown top-level fields with 400", async () => {
    api = await bootTestApi();

    const res = await fetch(`${api.baseUrl}/api/org`, {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ id: "hacked" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an unknown features.* key with 400", async () => {
    api = await bootTestApi();

    const res = await fetch(`${api.baseUrl}/api/org`, {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ features: { bogus: true } }),
    });
    expect(res.status).toBe(400);
  });

  it("sets the team-sync group allowlist, normalized, and GET reflects it", async () => {
    api = await bootTestApi();

    // Never set reads as an empty list on the wire — the client needs no
    // null case, and both states mirror nothing.
    const before = await fetch(`${api.baseUrl}/api/org`, { headers: HEADERS });
    expect(((await before.json()) as OrgResponse).ssoTeamGroups).toEqual([]);

    const res = await fetch(`${api.baseUrl}/api/org`, {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ ssoTeamGroups: [" /platform ", "/research", "/platform"] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OrgResponse;
    expect(body.ssoTeamGroups).toEqual(["/platform", "/research"]);

    const getRes = await fetch(`${api.baseUrl}/api/org`, { headers: HEADERS });
    expect(((await getRes.json()) as OrgResponse).ssoTeamGroups).toEqual(["/platform", "/research"]);
  });

  it("rejects a group entry that is not a top-level path, naming the shape", async () => {
    api = await bootTestApi();

    const res = await fetch(`${api.baseUrl}/api/org`, {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ ssoTeamGroups: ["platform"] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe(SSO_TEAM_GROUP_SHAPE_ERROR);
  });

  it("an empty features object is a 200 no-op that leaves the gate unchanged", async () => {
    api = await bootTestApi();

    const res = await fetch(`${api.baseUrl}/api/org`, {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ features: {} }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OrgResponse;
    expect(body.features.organizations).toBe(false);

    const getRes = await fetch(`${api.baseUrl}/api/org`, { headers: HEADERS });
    const getBody = (await getRes.json()) as OrgResponse;
    expect(getBody.features.organizations).toBe(false);
  });

  it("401s without auth configured", async () => {
    api = await bootTestApi();
    const prev = process.env.VALET_LOCAL_AUTH;
    process.env.VALET_LOCAL_AUTH = "0";
    try {
      const res = await fetch(`${api.baseUrl}/api/org`, {
        method: "PATCH",
        headers: HEADERS,
        body: JSON.stringify({ name: "x" }),
      });
      expect(res.status).toBe(401);
    } finally {
      process.env.VALET_LOCAL_AUTH = prev;
    }
  });
});

describe("GET /api/org/members", () => {
  it("404s with gate off, even for an admin", async () => {
    api = await bootTestApi();

    const res = await fetch(`${api.baseUrl}/api/org/members`, { headers: HEADERS });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("organizations not enabled");
  });

  it("returns member rows for an admin once the gate is on", async () => {
    api = await bootTestApi();
    await enableGate(api.baseUrl);

    const res = await fetch(`${api.baseUrl}/api/org/members`, { headers: HEADERS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OrgMembersResponse;
    const ids = body.members.map((m) => m.userId);
    expect(ids).toContain("local-user");
    expect(ids).toContain("test-member");
    expect(ids).toContain("test-admin");
    const localUser = body.members.find((m) => m.userId === "local-user");
    expect(localUser).toMatchObject({ email: "local@dev", role: "admin" });
  });

  it("403s for a non-admin org member, gate on", async () => {
    api = await bootTestApi();
    await enableGate(api.baseUrl);

    const res = await fetch(`${api.baseUrl}/api/org/members`, { headers: MEMBER_HEADERS });
    expect(res.status).toBe(403);
  });

  it("401s without auth configured", async () => {
    api = await bootTestApi();
    await enableGate(api.baseUrl);
    const prev = process.env.VALET_LOCAL_AUTH;
    process.env.VALET_LOCAL_AUTH = "0";
    try {
      const res = await fetch(`${api.baseUrl}/api/org/members`);
      expect(res.status).toBe(401);
    } finally {
      process.env.VALET_LOCAL_AUTH = prev;
    }
  });
});

describe("PATCH /api/org/members/:userId", () => {
  it("404s with gate off, even for an admin", async () => {
    api = await bootTestApi();

    const res = await fetch(`${api.baseUrl}/api/org/members/test-member`, {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ role: "admin" }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("organizations not enabled");
  });

  it("flips a member's role", async () => {
    api = await bootTestApi();
    await enableGate(api.baseUrl);

    const res = await fetch(`${api.baseUrl}/api/org/members/test-member`, {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ role: "admin" }),
    });
    expect(res.status).toBe(200);

    const membersRes = await fetch(`${api.baseUrl}/api/org/members`, { headers: HEADERS });
    const membersBody = (await membersRes.json()) as OrgMembersResponse;
    const target = membersBody.members.find((m) => m.userId === "test-member");
    expect(target?.role).toBe("admin");
  });

  it("403s for a non-admin org member, gate on", async () => {
    api = await bootTestApi();
    await enableGate(api.baseUrl);

    const res = await fetch(`${api.baseUrl}/api/org/members/local-user`, {
      method: "PATCH",
      headers: MEMBER_HEADERS,
      body: JSON.stringify({ role: "member" }),
    });
    expect(res.status).toBe(403);
  });

  it("400s with the exact copy string when demoting the sole admin", async () => {
    api = await bootTestApi();
    await enableGate(api.baseUrl);

    // Demote test-admin (the second admin) first so local-user is sole admin.
    const demoteSecond = await fetch(`${api.baseUrl}/api/org/members/test-admin`, {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ role: "member" }),
    });
    expect(demoteSecond.status).toBe(200);

    const res = await fetch(`${api.baseUrl}/api/org/members/local-user`, {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ role: "member" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe(LAST_ADMIN_ERROR);
  });

  it("401s without auth configured", async () => {
    api = await bootTestApi();
    await enableGate(api.baseUrl);
    const prev = process.env.VALET_LOCAL_AUTH;
    process.env.VALET_LOCAL_AUTH = "0";
    try {
      const res = await fetch(`${api.baseUrl}/api/org/members/test-member`, {
        method: "PATCH",
        headers: HEADERS,
        body: JSON.stringify({ role: "admin" }),
      });
      expect(res.status).toBe(401);
    } finally {
      process.env.VALET_LOCAL_AUTH = prev;
    }
  });

  it("404s for a userId with no membership row in the org", async () => {
    api = await bootTestApi();
    await enableGate(api.baseUrl);

    const res = await fetch(`${api.baseUrl}/api/org/members/nonexistent-user`, {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ role: "admin" }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("member not found");
  });

  it("400s for an invalid role value", async () => {
    api = await bootTestApi();
    await enableGate(api.baseUrl);

    const res = await fetch(`${api.baseUrl}/api/org/members/test-member`, {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ role: "owner" }),
    });
    expect(res.status).toBe(400);
  });
});
