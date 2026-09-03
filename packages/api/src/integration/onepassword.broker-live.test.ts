// @vitest-environment node
/**
 * The sandbox secret broker, against the REAL 1Password SDK and a REAL
 * sandbox token.
 *
 * `routes/sandbox-secrets.test.ts` drives this route with a fake service, so
 * it proves the policy and none of the plumbing. Nothing else reaches the
 * broker at all: no e2e row runs `valet-secrets`, and the route is the one
 * seam where the sandbox rung, the owner rule, the SDK, and the base64
 * round trip meet. A resolver that works against a fake and fails against
 * the SDK would look identical to a working one until a demo.
 *
 * Key-gated on `OP_SERVICE_ACCOUNT_TOKEN` and `OP_TEST_REFERENCE`, like the
 * other live rows. The resolved value is asserted by length and by equality
 * with a direct SDK read, never printed.
 */
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryCredentialStore } from "@valet/engine";
import { bootTestApi, type TestApi } from "./_setup.js";
import { mintSandboxToken } from "../auth/sandbox-tokens.js";
import { agentSessions } from "../schema/index.js";
import { createOnePasswordService, ONEPASSWORD_SERVICE } from "../services/onepassword.js";

const TOKEN = process.env.OP_SERVICE_ACCOUNT_TOKEN;
const REFERENCE = process.env.OP_TEST_REFERENCE;
const describeIfLive = TOKEN && REFERENCE ? describe : describe.skip;

const orgId = "local-org";
let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

/**
 * The real service, reading the token from a store the way boot does.
 *
 * `scope` decides WHERE the token is stored, which is the only difference
 * between an org service account and a personal one: `requireToken` reads
 * `{type:"org", id:orgId}` for the org scope and `{type:"user", id:userId}`
 * for the personal one. A personal token additionally needs the org's
 * allow-personal toggle, which defaults on.
 */
function realService(token: string, scope: "org" | "personal" = "org", userId = "local-user") {
  const store = new InMemoryCredentialStore();
  const owner = scope === "org" ? { type: "org" as const, id: orgId } : { type: "user" as const, id: userId };
  return {
    service: createOnePasswordService({
      credentials: store,
      getAllowPersonal: async () => true,
    }),
    ready: store.save(owner, ONEPASSWORD_SERVICE, {
      type: "service_account",
      apiKey: token,
    }),
  };
}

async function seedSession(
  db: TestApi["providers"]["db"],
  row: { id: string; ownerType: string; ownerId: string; userId: string },
): Promise<void> {
  await db.insert(agentSessions).values({
    ...row,
    orgId,
    workspace: "/workspace",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}

async function resolveVia(token: string, references: string[]): Promise<Response> {
  return fetch(`${api!.baseUrl}/api/sandbox-secrets/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-valet-sandbox": token },
    body: JSON.stringify({ references }),
  });
}

type Resp = { values: (string | null)[]; unresolved: string[] };

async function postSandbox(path: string, token: string, body: unknown): Promise<Response> {
  return fetch(`${api!.baseUrl}/api/sandbox-secrets/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-valet-sandbox": token },
    body: JSON.stringify(body),
  });
}

describeIfLive("api integration: the secret broker against a real vault", () => {
  it("resolves a real reference for the session's own user, byte-for-byte", async () => {
    if (!TOKEN || !REFERENCE) throw new Error("unreachable: gated above");
    api = await bootTestApi();
    const { service, ready } = realService(TOKEN);
    await ready;
    api.providers.onePassword = service;

    await seedSession(api.providers.db, {
      id: "sess-broker-live",
      ownerType: "user",
      ownerId: "local-user",
      userId: "local-user",
    });
    const { token } = await mintSandboxToken(api.providers.db, {
      sessionId: "sess-broker-live",
      userId: "local-user",
      orgId,
    });

    const res = await resolveVia(token, [REFERENCE]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Resp;
    expect(body.unresolved).toEqual([]);

    // The CLI decodes base64 to restore exact bytes. Compare against what the
    // SDK returns directly, so a mangling encoder cannot pass.
    const direct = await service.resolveReference("org", { orgId, userId: "local-user" }, REFERENCE);
    const delivered = Buffer.from(body.values[0]!, "base64").toString("utf8");
    expect(delivered).toBe(direct);
    expect(delivered.length).toBeGreaterThan(0);
  }, 60_000);

  // The owner rule, through the real service: a team-owned session reaches the
  // org token and nothing else, and still resolves an org-vault reference.
  it("resolves for a team-owned session on the org scope", async () => {
    if (!TOKEN || !REFERENCE) throw new Error("unreachable: gated above");
    api = await bootTestApi();
    const { service, ready } = realService(TOKEN);
    await ready;
    api.providers.onePassword = service;

    await seedSession(api.providers.db, {
      id: "sess-broker-team",
      ownerType: "team",
      ownerId: "team-1",
      userId: "local-user",
    });
    const { token } = await mintSandboxToken(api.providers.db, {
      sessionId: "sess-broker-team",
      userId: "local-user",
      orgId,
    });

    const res = await resolveVia(token, [REFERENCE]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Resp;
    expect(body.unresolved).toEqual([]);
    expect(Buffer.from(body.values[0]!, "base64").toString("utf8").length).toBeGreaterThan(0);
  }, 60_000);

  // A reference the token cannot read is named, not thrown: the CLI decides
  // whether a miss is fatal and says which one failed.
  it("names a reference the token cannot read", async () => {
    if (!TOKEN || !REFERENCE) throw new Error("unreachable: gated above");
    api = await bootTestApi();
    const { service, ready } = realService(TOKEN);
    await ready;
    api.providers.onePassword = service;

    await seedSession(api.providers.db, {
      id: "sess-broker-miss",
      ownerType: "user",
      ownerId: "local-user",
      userId: "local-user",
    });
    const { token } = await mintSandboxToken(api.providers.db, {
      sessionId: "sess-broker-miss",
      userId: "local-user",
      orgId,
    });

    const missing = "op://no-such-vault-here/no-such-item/password";
    const res = await resolveVia(token, [missing]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Resp;
    expect(body.values[0]).toBeNull();
    expect(body.unresolved).toEqual([missing]);
  }, 60_000);

  // The personal scope, with NO org token connected: the org scope has
  // nothing to offer and yields, and the user's own token answers. This is
  // the path a person testing with their own 1Password account takes.
  it("resolves through a PERSONAL token when the session is that user's own", async () => {
    if (!TOKEN || !REFERENCE) throw new Error("unreachable: gated above");
    api = await bootTestApi();
    const { service, ready } = realService(TOKEN, "personal", "local-user");
    await ready;
    api.providers.onePassword = service;

    await seedSession(api.providers.db, {
      id: "sess-broker-personal",
      ownerType: "user",
      ownerId: "local-user",
      userId: "local-user",
    });
    const { token } = await mintSandboxToken(api.providers.db, {
      sessionId: "sess-broker-personal",
      userId: "local-user",
      orgId,
    });

    const res = await resolveVia(token, [REFERENCE]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Resp;
    expect(body.unresolved).toEqual([]);
    const delivered = Buffer.from(body.values[0]!, "base64").toString("utf8");
    expect(delivered.length).toBeGreaterThan(0);
  }, 60_000);

  // The owner rule, proved against the real service rather than a fake: the
  // same personal token, the same reference, a session the frozen actor's
  // colleagues can prompt. The personal scope is never consulted, so the
  // read finds nothing rather than handing out that actor's private item.
  it("does NOT reach a personal token from a team-owned session", async () => {
    if (!TOKEN || !REFERENCE) throw new Error("unreachable: gated above");
    api = await bootTestApi();
    const { service, ready } = realService(TOKEN, "personal", "local-user");
    await ready;
    api.providers.onePassword = service;

    await seedSession(api.providers.db, {
      id: "sess-broker-team-personal",
      ownerType: "team",
      ownerId: "team-1",
      userId: "local-user",
    });
    const { token } = await mintSandboxToken(api.providers.db, {
      sessionId: "sess-broker-team-personal",
      userId: "local-user",
      orgId,
    });

    const res = await resolveVia(token, [REFERENCE]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Resp;
    expect(body.values[0]).toBeNull();
    expect(body.unresolved).toEqual([REFERENCE]);
  }, 60_000);

  it("find returns scope-tagged references and no values", async () => {
    api = await bootTestApi();
    const { service, ready } = realService(TOKEN!, "org");
    await ready;
    api.providers.onePassword = service;
    await seedSession(api.providers.db, { id: "s-find", ownerType: "user", ownerId: "local-user", userId: "local-user" });
    const { token } = await mintSandboxToken(api.providers.db, { sessionId: "s-find", userId: "local-user", orgId });

    const res = await postSandbox("find", token, { query: "claude" });
    expect(res.status).toBe(200);
    const text = await res.text();
    console.log("FIND OUTPUT:\n" + text);
    expect(text).toContain("op://");
    expect(text).toMatch(/^(org|personal)\t/m);
    // 108-char key must not appear anywhere in a find response.
    expect(text).not.toMatch(/sk-ant-/);
  }, 90_000);

  it("a team-owned session asking for the personal scope is refused by name", async () => {
    api = await bootTestApi();
    const { service, ready } = realService(TOKEN!, "org");
    await ready;
    api.providers.onePassword = service;
    await seedSession(api.providers.db, { id: "s-team", ownerType: "team", ownerId: "team-1", userId: "local-user" });
    const { token } = await mintSandboxToken(api.providers.db, { sessionId: "s-team", userId: "local-user", orgId });

    const res = await postSandbox("resolve", token, { references: ["op://ProDex Labs/Claude API Key/notesPlain"], scope: "personal" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    console.log("REFUSAL: " + body.error);
    expect(body.error).toContain("organization vaults only");
  }, 90_000);

  it("scope: org still resolves for a user-owned session", async () => {
    api = await bootTestApi();
    const { service, ready } = realService(TOKEN!, "org");
    await ready;
    api.providers.onePassword = service;
    await seedSession(api.providers.db, { id: "s-scoped", ownerType: "user", ownerId: "local-user", userId: "local-user" });
    const { token } = await mintSandboxToken(api.providers.db, { sessionId: "s-scoped", userId: "local-user", orgId });

    const res = await postSandbox("resolve", token, { references: ["op://ProDex Labs/Claude API Key/notesPlain"], scope: "org" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { values: (string | null)[]; unresolved: string[] };
    expect(body.unresolved).toEqual([]);
    expect(Buffer.from(body.values[0]!, "base64").toString("utf8").length).toBe(108);
  }, 90_000);

  it("refuses the same reference with no sandbox token", async () => {
    if (!TOKEN || !REFERENCE) throw new Error("unreachable: gated above");
    api = await bootTestApi();
    const { service, ready } = realService(TOKEN);
    await ready;
    api.providers.onePassword = service;

    const res = await fetch(`${api.baseUrl}/api/sandbox-secrets/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ references: [REFERENCE] }),
    });
    expect(res.status).toBe(401);
  }, 60_000);
});
