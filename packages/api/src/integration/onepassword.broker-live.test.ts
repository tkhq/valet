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

/** The real service, reading the org token from a store the way boot does. */
function realService(token: string) {
  const store = new InMemoryCredentialStore();
  return {
    service: createOnePasswordService({
      credentials: store,
      getAllowPersonal: async () => true,
    }),
    ready: store.save({ type: "org", id: orgId }, ONEPASSWORD_SERVICE, {
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
