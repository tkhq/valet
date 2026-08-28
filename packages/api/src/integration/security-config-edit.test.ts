/**
 * Focus + invariants edit route (dynamic-config M-F3): the panel's config
 * editor write path. POST /security/config sets focus + invariants during
 * planning, the GET reflects them, and the route refuses a running engagement
 * and a non-admin caller. No engine turns and no ANTHROPIC_API_KEY.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bootTestApi } from "./_setup.js";
import { securityEngagements, users } from "../schema/index.js";
import type {
  CreateSessionResponse,
  GetSessionSecurityResponse,
  SecuritySetConfigResponse,
} from "../wire/types.js";

const REPO = { fullName: "acme/api", cloneUrl: "https://github.com/acme/api.git" };

async function createSecuritySession(baseUrl: string): Promise<CreateSessionResponse> {
  const res = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspace: "/tmp/valet-security-config-edit", kind: "security", repo: REPO }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as CreateSessionResponse;
}

function postConfig(
  baseUrl: string,
  id: string,
  // `Record<string, unknown>` so a validation test can send an ill-typed
  // field (numeric invariants) without a double-cast.
  body: Record<string, unknown>,
  headers?: Record<string, string>,
) {
  return fetch(`${baseUrl}/api/sessions/${id}/security/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(headers ?? {}) },
    body: JSON.stringify(body),
  });
}

async function getSecurity(baseUrl: string, id: string): Promise<GetSessionSecurityResponse> {
  return (await (await fetch(`${baseUrl}/api/sessions/${id}/security`)).json()) as GetSessionSecurityResponse;
}

describe("api integration: focus + invariants config edit", () => {
  it("sets focus + invariants and the GET reflects them", async () => {
    const api = await bootTestApi();
    try {
      const created = await createSecuritySession(api.baseUrl);
      const res = await postConfig(api.baseUrl, created.id, {
        focus: "the multi-tenant data path",
        invariants: [
          "every admin route sits behind requireAdmin",
          "tenant id is always checked in the repository layer",
        ],
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as SecuritySetConfigResponse;
      expect(body.focus).toBe("the multi-tenant data path");
      expect(body.invariants).toEqual([
        "every admin route sits behind requireAdmin",
        "tenant id is always checked in the repository layer",
      ]);

      const sec = await getSecurity(api.baseUrl, created.id);
      expect(sec.engagement.focus).toBe("the multi-tenant data path");
      expect(sec.engagement.invariants).toEqual([
        "every admin route sits behind requireAdmin",
        "tenant id is always checked in the repository layer",
      ]);
    } finally {
      await api.cleanup();
    }
  });

  it("clears focus + invariants with empty values", async () => {
    const api = await bootTestApi();
    try {
      const created = await createSecuritySession(api.baseUrl);
      await postConfig(api.baseUrl, created.id, { focus: "temporary", invariants: ["x"] });
      const res = await postConfig(api.baseUrl, created.id, { focus: "", invariants: [] });
      expect(res.status).toBe(200);
      const body = (await res.json()) as SecuritySetConfigResponse;
      expect(body.focus).toBeNull();
      expect(body.invariants).toEqual([]);

      const sec = await getSecurity(api.baseUrl, created.id);
      expect(sec.engagement.focus).toBeNull();
      expect(sec.engagement.invariants).toBeNull();
    } finally {
      await api.cleanup();
    }
  });

  it("refuses to edit a running engagement, surfacing the immutable error", async () => {
    const api = await bootTestApi();
    try {
      const created = await createSecuritySession(api.baseUrl);
      const sec = await getSecurity(api.baseUrl, created.id);
      await api.providers.db
        .update(securityEngagements)
        .set({ status: "running" })
        .where(eq(securityEngagements.id, sec.engagement.id));

      const res = await postConfig(api.baseUrl, created.id, { focus: "too late" });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("immutable");
    } finally {
      await api.cleanup();
    }
  });

  it("rejects a malformed body naming the corrective action", async () => {
    const api = await bootTestApi();
    try {
      const created = await createSecuritySession(api.baseUrl);
      // invariants must be a string list.
      const res = await postConfig(api.baseUrl, created.id, {
        invariants: [1, 2],
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("invariants must be a list of strings");
    } finally {
      await api.cleanup();
    }
  });

  it("refuses a non-admin, non-internal caller with the existence-hiding 404", async () => {
    const api = await bootTestApi();
    try {
      const created = await createSecuritySession(api.baseUrl);
      const { db } = api.providers;
      await db.insert(users).values({ id: "intruder", email: "intruder@x.test", name: "I", role: "member" });
      const res = await postConfig(
        api.baseUrl,
        created.id,
        { focus: "sneak" },
        { "x-valet-test-user-id": "intruder" },
      );
      expect(res.status).toBe(404);
    } finally {
      await api.cleanup();
    }
  });

  it("admits a human admin (the session owner) on the mutate ladder", async () => {
    const api = await bootTestApi();
    try {
      const created = await createSecuritySession(api.baseUrl);
      const res = await postConfig(api.baseUrl, created.id, { focus: "owner edit" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as SecuritySetConfigResponse;
      expect(body.focus).toBe("owner edit");
    } finally {
      await api.cleanup();
    }
  });

  it("sets threat categories and the GET reflects them (M-P2a)", async () => {
    const api = await bootTestApi();
    try {
      const created = await createSecuritySession(api.baseUrl);
      const res = await postConfig(api.baseUrl, created.id, {
        categories: ["authz", "webhooks"],
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as SecuritySetConfigResponse;
      expect(body.categories).toEqual(["authz", "webhooks"]);

      const sec = await getSecurity(api.baseUrl, created.id);
      expect(sec.engagement.categories).toEqual(["authz", "webhooks"]);
    } finally {
      await api.cleanup();
    }
  });

  it("rejects an unknown threat category naming the corrective action (M-P2a)", async () => {
    const api = await bootTestApi();
    try {
      const created = await createSecuritySession(api.baseUrl);
      const res = await postConfig(api.baseUrl, created.id, {
        categories: ["authz", "made-up"],
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('"made-up"');
      expect(body.error).toContain("Known categories:");
    } finally {
      await api.cleanup();
    }
  });

  it("refuses a categories edit on a running engagement (M-P2a)", async () => {
    const api = await bootTestApi();
    try {
      const created = await createSecuritySession(api.baseUrl);
      const sec = await getSecurity(api.baseUrl, created.id);
      await api.providers.db
        .update(securityEngagements)
        .set({ status: "running" })
        .where(eq(securityEngagements.id, sec.engagement.id));

      const res = await postConfig(api.baseUrl, created.id, { categories: ["authz"] });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("immutable");
    } finally {
      await api.cleanup();
    }
  });
});
