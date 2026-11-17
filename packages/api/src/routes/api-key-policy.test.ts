/**
 * API key expiry and the org key policy
 * (`docs/specs/2026-07-14-auth-v2-design.md`, update of 2026-11-17). Real better-auth,
 * real routes: the personal create and update go through the better-auth
 * hook, team keys through `/api/teams/:id/api-keys`, and proxy keys through
 * the CLI device routes.
 */
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { bootstrapAdminInviteCode } from "../test-helpers/bootstrap-admin-code.js";
import { mintCliToken } from "../auth/cli-tokens.js";
import { apikey, users } from "../schema/index.js";
import { PERSONAL_API_KEYS_OFF_MESSAGE } from "../services/api-key-policy.js";
import { PROXY_KEY_POLICY_OFF } from "./cli-device.js";
import type {
  CreateInviteResponse,
  CreateTeamApiKeyResponse,
  CreateTeamResponse,
  ListTeamApiKeysResponse,
  OrgResponse,
} from "../wire/types.js";

const DAY = 86_400;
const DAY_MS = DAY * 1000;

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

function sessionCookie(setCookie: string | null): string {
  const match = setCookie?.match(/better-auth\.session_token=[^;]+/);
  if (!match) throw new Error("no session cookie");
  return match[0];
}

async function signUp(base: string, email: string, inviteCode: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: email, email, password: "correct-horse-battery", inviteCode }),
  });
  expect(res.status).toBe(200);
  return sessionCookie(res.headers.get("set-cookie"));
}

/** An org admin and a plain member in one org. */
async function setup(): Promise<{ testApi: TestApi; base: string; admin: string; member: string }> {
  const testApi = await bootTestApi({ auth: true });
  api = testApi;
  const base = testApi.baseUrl;
  const admin = await signUp(base, "admin@nowhere.test", await bootstrapAdminInviteCode(testApi.providers.db));
  const invite = await fetch(`${base}/api/org/invites`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: admin },
    body: JSON.stringify({ role: "member" }),
  });
  expect(invite.status).toBe(200);
  const member = await signUp(base, "member@nowhere.test", ((await invite.json()) as CreateInviteResponse).code);
  return { testApi, base, admin, member };
}

function patchPolicy(base: string, cookie: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${base}/api/org/settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
}

function createPersonalKey(base: string, cookie: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${base}/api/auth/api-key/create`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
}

async function createTeam(base: string, cookie: string): Promise<string> {
  const res = await fetch(`${base}/api/teams`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "Platform" }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as CreateTeamResponse).team.id;
}

function createTeamKey(base: string, cookie: string, teamId: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${base}/api/teams/${teamId}/api-keys`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
}

/** Asserts `expiresAt` is `days` from now, within a minute. */
function expectExpiresInDays(expiresAt: string | number | null, days: number): void {
  expect(expiresAt).not.toBeNull();
  const at = new Date(expiresAt ?? 0).getTime();
  expect(Math.abs(at - (Date.now() + days * DAY_MS))).toBeLessThan(60_000);
}

describe("API key expiry", () => {
  it("stores the chosen expiry and refuses the key after it passes", async () => {
    const { testApi, base, member } = await setup();
    const res = await createPersonalKey(base, member, { name: "short", expiresIn: 30 * DAY });
    expect(res.status).toBe(200);
    const created = (await res.json()) as { id: string; key: string; expiresAt: string | null };
    expectExpiresInDays(created.expiresAt, 30);
    expect((await fetch(`${base}/api/me`, { headers: { "x-api-key": created.key } })).status).toBe(200);

    // Move the expiry into the past, as if 30 days went by.
    await testApi.providers.db
      .update(apikey)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(apikey.id, created.id));
    expect((await fetch(`${base}/api/me`, { headers: { "x-api-key": created.key } })).status).toBe(401);
    // better-auth deletes an expired key when someone presents it.
    expect(await testApi.providers.db.select().from(apikey).where(eq(apikey.id, created.id))).toEqual([]);
  });

  it("keeps a key with no expiry working when the org has no maximum", async () => {
    const { base, member } = await setup();
    const res = await createPersonalKey(base, member, { name: "forever", expiresIn: null });
    expect(res.status).toBe(200);
    const created = (await res.json()) as { key: string; expiresAt: string | null };
    expect(created.expiresAt).toBeNull();
    expect((await fetch(`${base}/api/me`, { headers: { "x-api-key": created.key } })).status).toBe(200);
  });

  it("returns the expiry of a team key on create and in the list", async () => {
    const { base, admin } = await setup();
    const teamId = await createTeam(base, admin);
    const res = await createTeamKey(base, admin, teamId, { name: "CI", expiresIn: 90 * DAY });
    expect(res.status).toBe(201);
    const created = (await res.json()) as CreateTeamApiKeyResponse;
    expectExpiresInDays(created.expiresAt, 90);
    const list = (await (await fetch(`${base}/api/teams/${teamId}/api-keys`, { headers: { cookie: admin } })).json()) as ListTeamApiKeysResponse;
    expect(list.keys[0]?.expiresAt).toBe(created.expiresAt);

    const bad = await createTeamKey(base, admin, teamId, { name: "CI", expiresIn: 10 });
    expect(bad.status).toBe(400);
  });
});

describe("org API key policy", () => {
  it("defaults to personal keys on and no maximum, and validates the patch", async () => {
    const { base, admin, member } = await setup();
    const org = (await (await fetch(`${base}/api/org`, { headers: { cookie: member } })).json()) as OrgResponse;
    expect(org).toMatchObject({ allowPersonalApiKeys: true, maxApiKeyLifetimeDays: null });

    expect((await patchPolicy(base, admin, { maxApiKeyLifetimeDays: 45 })).status).toBe(400);
    expect((await patchPolicy(base, admin, { allowPersonalApiKeys: "no" })).status).toBe(400);
    expect((await patchPolicy(base, member, { maxApiKeyLifetimeDays: 90 })).status).toBe(403);
    const ok = await patchPolicy(base, admin, { allowPersonalApiKeys: false, maxApiKeyLifetimeDays: 90 });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ allowPersonalApiKeys: false, maxApiKeyLifetimeDays: 90 });
  });

  it("refuses a personal key when the org turns personal keys off, and keeps team keys", async () => {
    const { base, admin, member } = await setup();
    const before = (await (await createPersonalKey(base, member, { name: "old" })).json()) as { key: string };
    expect((await patchPolicy(base, admin, { allowPersonalApiKeys: false })).status).toBe(200);

    const refused = await createPersonalKey(base, member, { name: "new", expiresIn: 30 * DAY });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { message?: string }).message).toBe(PERSONAL_API_KEYS_OFF_MESSAGE);
    // The switch applies to admins too: an admin turns it back on to get a key.
    expect((await createPersonalKey(base, admin, { name: "admin" })).status).toBe(403);

    // A key made before the switch keeps working.
    expect((await fetch(`${base}/api/me`, { headers: { "x-api-key": before.key } })).status).toBe(200);

    const teamId = await createTeam(base, admin);
    expect((await createTeamKey(base, admin, teamId, { name: "CI" })).status).toBe(201);
  });

  it("holds personal keys to the org maximum", async () => {
    const { base, admin, member } = await setup();
    expect((await patchPolicy(base, admin, { maxApiKeyLifetimeDays: 90 })).status).toBe(200);

    const tooLong = await createPersonalKey(base, member, { name: "year", expiresIn: 365 * DAY });
    expect(tooLong.status).toBe(400);
    expect(((await tooLong.json()) as { message?: string }).message).toMatch(/within 90 days/);
    expect((await createPersonalKey(base, member, { name: "never", expiresIn: null })).status).toBe(400);

    const shorter = await createPersonalKey(base, member, { name: "month", expiresIn: 30 * DAY });
    expect(shorter.status).toBe(200);
    expectExpiresInDays(((await shorter.json()) as { expiresAt: string | null }).expiresAt, 30);

    // An older client that sends no expiry gets the maximum.
    const omitted = await createPersonalKey(base, member, { name: "old client" });
    expect(omitted.status).toBe(200);
    const created = (await omitted.json()) as { id: string; expiresAt: string | null };
    expectExpiresInDays(created.expiresAt, 90);

    // The update route cannot lift the key past the maximum.
    const update = (expiresIn: number | null) => fetch(`${base}/api/auth/api-key/update`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: member },
      body: JSON.stringify({ keyId: created.id, expiresIn }),
    });
    expect((await update(null)).status).toBe(400);
    expect((await update(365 * DAY)).status).toBe(400);
    expect((await update(30 * DAY)).status).toBe(200);
  });

  it("holds team keys to the org maximum", async () => {
    const { base, admin } = await setup();
    const teamId = await createTeam(base, admin);
    expect((await patchPolicy(base, admin, { maxApiKeyLifetimeDays: 30 })).status).toBe(200);

    const never = await createTeamKey(base, admin, teamId, { name: "CI", expiresIn: null });
    expect(never.status).toBe(400);
    expect(((await never.json()) as { error: string }).error).toMatch(/within 30 days/);
    expect((await createTeamKey(base, admin, teamId, { name: "CI", expiresIn: 90 * DAY })).status).toBe(400);

    const omitted = await createTeamKey(base, admin, teamId, { name: "CI" });
    expect(omitted.status).toBe(201);
    expectExpiresInDays(((await omitted.json()) as CreateTeamApiKeyResponse).expiresAt, 30);
  });

  it("refuses a proxy key request when personal keys are off; CLI sign-in still works", async () => {
    const { testApi, base, admin } = await setup();
    const [row] = await testApi.providers.db.select({ id: users.id }).from(users).where(eq(users.email, "member@nowhere.test"));
    if (!row) throw new Error("no member row");
    const cliToken = (await mintCliToken(testApi.providers.db, row.id, "test-box", Date.now())).access_token;
    const startProxyKey = () => fetch(`${base}/api/cli/device/code`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": cliToken },
      body: JSON.stringify({ device: "test-box", purpose: "proxy-key", key_name: "laptop" }),
    });
    expect((await startProxyKey()).status).toBe(200);

    expect((await patchPolicy(base, admin, { allowPersonalApiKeys: false })).status).toBe(200);
    const refused = await startProxyKey();
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "unauthorized_client", error_description: PROXY_KEY_POLICY_OFF });

    // A login mints a CLI token, not an API key, so the switch does not touch it.
    const login = await fetch(`${base}/api/cli/device/code`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device: "test-box" }),
    });
    expect(login.status).toBe(200);
  });
});
