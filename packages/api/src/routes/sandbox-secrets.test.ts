// @vitest-environment node
/**
 * The broker route: what a sandbox CLI is allowed to ask for, and what it
 * gets back when it asks for something silly.
 */
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { mintSandboxToken } from "../auth/sandbox-tokens.js";
import { agentSessions, childWatches, securityCells, securityEngagements, teams } from "../schema/index.js";
import { ONEPASSWORD_SERVICE, OnePasswordAuthError, type OnePasswordService } from "../services/onepassword.js";
import type { StoredCredential } from "@valet/engine";

let api: TestApi | undefined;
afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

/** Resolves anything under `op://ok/`, refuses the rest with "no token here". */
function fakeOnePassword(): OnePasswordService {
  const unused = (): never => {
    throw new Error("not exercised by this suite");
  };
  return {
    tokenConnected: unused,
    listVaults: unused,
    findCredentialForService: async () => null,
    findCandidates: async () => [],
    resolveCredential: async (row: StoredCredential) => row,
    resolveReference: async (_scope, _ctx, reference) => {
      if (!reference.startsWith("op://ok/")) throw new OnePasswordAuthError("no such item", "no_token");
      return `secret-for-${reference}`;
    },
  };
}

const HEADERS = { "Content-Type": "application/json" };

/** The CLI's real credential. The route derives org and user from this token,
 * so a suite that omitted it exercised a rung the CLI never uses. */
async function mintToken(sessionId = "sess-secrets-1"): Promise<string> {
  const { token } = await mintSandboxToken(api!.providers.db, {
    sessionId,
    userId: "local-user",
    orgId: "local-org",
  });
  return token;
}

async function resolve(references: unknown, token?: string) {
  const headers: Record<string, string> = { ...HEADERS };
  const sandboxToken = token ?? (await mintToken());
  headers["x-valet-sandbox"] = sandboxToken;
  return fetch(`${api!.baseUrl}/api/sandbox-secrets/resolve`, {
    method: "POST",
    headers,
    body: JSON.stringify({ references }),
  });
}

/** Base64 in, plain text out — the shape the shell CLI decodes. */
function decode(value: string | null): string | null {
  return value === null ? null : Buffer.from(value, "base64").toString("utf8");
}
type Resp = { values: (string | null)[]; unresolved: string[] };

describe("POST /api/sandbox-secrets/resolve", () => {
  it("resolves the references it can and names the ones it cannot", async () => {
    api = await bootTestApi();
    api.providers.onePassword = fakeOnePassword();

    const res = await resolve(["op://ok/item/field", "op://nope/item/field"]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Resp;

    expect(decode(body.values[0])).toBe("secret-for-op://ok/item/field");
    // Named, not thrown: the CLI decides whether a miss is fatal, and can say
    // WHICH reference failed.
    expect(body.unresolved).toEqual(["op://nope/item/field"]);
    // A reference nobody resolved carries no value and no reason — the reason
    // would describe someone else's vault.
    expect(body.values[1]).toBeNull();
  });

  it("refuses anything that is not a secret reference", async () => {
    api = await bootTestApi();
    api.providers.onePassword = fakeOnePassword();

    // A path, an env var name, a file: the broker resolves references, and
    // refusing early keeps it from becoming a general read primitive.
    for (const bad of ["/etc/passwd", "HOME", "https://example.com", "op:/malformed"]) {
      const res = await resolve([bad]);
      expect(res.status, `should refuse ${bad}`).toBe(400);
    }
  });

  it("accepts a reference whose vault or item name contains spaces", async () => {
    api = await bootTestApi();
    api.providers.onePassword = fakeOnePassword();
    // "ProDex Labs" is an ordinary vault name: a reference may contain spaces.
    const res = await resolve(["op://ok/JumpCloud Login/password"]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Resp;
    expect(decode(body.values[0])).toBeTruthy();
  });

  it("bounds one request", async () => {
    api = await bootTestApi();
    api.providers.onePassword = fakeOnePassword();
    const many = Array.from({ length: 26 }, (_, i) => `op://ok/item/f${i}`);
    const res = await resolve(many);
    expect(res.status).toBe(400);
  });

  it("400s a body that is not an array of strings", async () => {
    api = await bootTestApi();
    api.providers.onePassword = fakeOnePassword();
    expect((await resolve("op://ok/item/field")).status).toBe(400);
    expect((await resolve([1, 2])).status).toBe(400);
  });
  // The CLI's only credential is the sandbox token, and the sandbox rung sets
  // `c.var.sandbox`, never `c.var.user`.
  it("answers a sandbox token, and the principal comes from that token", async () => {
    api = await bootTestApi();
    api.providers.onePassword = fakeOnePassword();

    const res = await resolve(["op://ok/item/field"], await mintToken());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Resp;
    expect(decode(body.values[0])).toBe("secret-for-op://ok/item/field");
  });

  it("refuses a caller with no sandbox token, and names the fix", async () => {
    api = await bootTestApi();
    api.providers.onePassword = fakeOnePassword();

    // A signed-in browser session must not read plaintext org secrets here —
    // the sibling browse route strips values for that reason.
    const res = await fetch(`${api.baseUrl}/api/sandbox-secrets/resolve`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ references: ["op://ok/item/field"] }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("valet-secrets");
  });

  it("names every unsupported reference, not just the first", async () => {
    api = await bootTestApi();
    api.providers.onePassword = fakeOnePassword();

    // The CLI aborts the whole run on this error. Naming one of two sent the
    // reader to debug a reference that was fine.
    const res = await resolve(["op://ok/item/field", "/etc/passwd", "HOME"]);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("/etc/passwd");
    expect(body.error).toContain("HOME");
  });

  it("base64 survives a value containing a quote, a backslash, and a newline", async () => {
    api = await bootTestApi();
    const nasty = 'pa"ss\\word\nsecond line\n';
    api.providers.onePassword = {
      ...fakeOnePassword(),
      resolveReference: async () => nasty,
    };

    const res = await resolve(["op://ok/item/field"]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Resp;
    // The old byte-level extractor cut this at the first quote and never
    // unescaped, so a private key arrived corrupted but plausible.
    expect(decode(body.values[0])).toBe(nasty);
  });
  // `sandbox.userId` is the actor frozen onto the session at creation, not
  // whoever is prompting now. Every member of a team can prompt a team-owned
  // session, so consulting that one person's personal vault would hand their
  // private items to their teammates.
  it("a team-owned session never reaches the frozen actor's personal vault", async () => {
    api = await bootTestApi();
    const scopesTried: string[] = [];
    api.providers.onePassword = {
      ...fakeOnePassword(),
      resolveReference: async (scope: string, _ctx: unknown, reference: string) => {
        scopesTried.push(scope);
        if (scope === "personal") return "PERSONAL-VAULT-VALUE";
        throw new OnePasswordAuthError("no token", "no_token");
      },
    };

    await api.providers.db.insert(teams).values({ id: "team-1", orgId: "local-org", name: "Test team", createdAt: Date.now() }).onConflictDoNothing();
    await api.providers.db.insert(agentSessions).values({
      id: "sess-team-1",
      userId: "user-a",
      orgId: "local-org",
      workspace: "/workspace",
      ownerType: "team",
      ownerId: "team-1",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const { token } = await mintSandboxToken(api.providers.db, {
      sessionId: "sess-team-1",
      userId: "user-a",
      orgId: "local-org",
    });

    const res = await resolve(["op://ok/item/field"], token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Resp;
    expect(scopesTried).toEqual(["team", "org"]);
    expect(body.values[0]).toBeNull();
    expect(body.unresolved).toEqual(["op://ok/item/field"]);
  });

  // A grant is a restriction an admin opts into. With no grant row a team
  // session reads the org scope as it did before grants existed, so a deploy
  // does not break every team session that never had one written.
  it("a team-owned session with no grant row reads every org ref", async () => {
    api = await bootTestApi();
    api.providers.onePassword = {
      ...fakeOnePassword(),
      findCandidates: async () => [{ vault: "ok", item: "item", field: "field" }],
    };
    await api.providers.db.insert(teams).values({ id: "team-1", orgId: "local-org", name: "Test team", createdAt: Date.now() }).onConflictDoNothing();
    await api.providers.db.insert(agentSessions).values({
      id: "sess-team-nogrant",
      userId: "local-user",
      orgId: "local-org",
      workspace: "/workspace",
      ownerType: "team",
      ownerId: "team-1",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const { token } = await mintSandboxToken(api.providers.db, {
      sessionId: "sess-team-nogrant",
      userId: "local-user",
      orgId: "local-org",
    });

    const resolved = await resolve(["op://ok/item/field"], token);
    expect(resolved.status).toBe(200);
    expect(decode(((await resolved.json()) as Resp).values[0])).toBe("secret-for-op://ok/item/field");

    const found = await fetch(`${api.baseUrl}/api/sandbox-secrets/find`, {
      method: "POST",
      headers: { ...HEADERS, "x-valet-sandbox": token },
      body: JSON.stringify({ query: "item" }),
    });
    expect(found.status).toBe(200);
    expect(await found.text()).toBe("team\top://ok/item/field");
  });

  it("a team-owned session ignores obsolete grants for token-accessible references", async () => {
    api = await bootTestApi();
    api.providers.onePassword = fakeOnePassword();
    await api.providers.db.insert(teams).values({ id: "team-1", orgId: "local-org", name: "Test team", createdAt: Date.now() }).onConflictDoNothing();
    await api.providers.db.insert(agentSessions).values({
      id: "sess-team-grant",
      userId: "local-user",
      orgId: "local-org",
      workspace: "/workspace",
      ownerType: "team",
      ownerId: "team-1",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await api.providers.engineCredentials.save({ type: "team", id: "team-1" }, ONEPASSWORD_SERVICE, {
      type: "service_account",
      metadata: { refs: ["op://ok/item/field"] },
    });
    const { token } = await mintSandboxToken(api.providers.db, {
      sessionId: "sess-team-grant",
      userId: "local-user",
      orgId: "local-org",
    });

    const granted = await resolve(["op://ok/item/field"], token);
    expect(granted.status).toBe(200);
    expect(decode(((await granted.json()) as Resp).values[0])).toBe("secret-for-op://ok/item/field");

    const refused = await resolve(["op://ok/other/field"], token);
    expect(refused.status).toBe(200);
    expect(decode(((await refused.json()) as Resp).values[0])).toBe("secret-for-op://ok/other/field");
  });

  it("a user-owned session still reaches that user's personal vault", async () => {
    api = await bootTestApi();
    const scopesTried: string[] = [];
    api.providers.onePassword = {
      ...fakeOnePassword(),
      resolveReference: async (scope: string) => {
        scopesTried.push(scope);
        if (scope === "personal") return "PERSONAL-VAULT-VALUE";
        throw new OnePasswordAuthError("no token", "no_token");
      },
    };

    await api.providers.db.insert(teams).values({ id: "team-1", orgId: "local-org", name: "Test team", createdAt: Date.now() }).onConflictDoNothing();
    await api.providers.db.insert(agentSessions).values({
      id: "sess-user-1",
      userId: "user-a",
      orgId: "local-org",
      workspace: "/workspace",
      ownerType: "user",
      ownerId: "user-a",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const { token } = await mintSandboxToken(api.providers.db, {
      sessionId: "sess-user-1",
      userId: "user-a",
      orgId: "local-org",
    });

    const res = await resolve(["op://ok/item/field"], token);
    const body = (await res.json()) as Resp;
    expect(scopesTried).toEqual(["org", "personal"]);
    expect(decode(body.values[0])).toBe("PERSONAL-VAULT-VALUE");
  });

  // A session changes hands while tokens minted before the move stay valid:
  // revocation is reserved for `destroy`, so `PATCH /api/sessions/:id` leaves
  // the earlier actor's token live. If the scope came from `ownerType` alone,
  // the new owner could present that token and read the earlier actor's
  // personal vault, since the route resolves with the TOKEN's user id.
  it("a user-owned session whose owner is not the token holder stays on the org token", async () => {
    api = await bootTestApi();
    const scopesTried: string[] = [];
    api.providers.onePassword = {
      ...fakeOnePassword(),
      resolveReference: async (scope: string) => {
        scopesTried.push(scope);
        if (scope === "personal") return "ACTOR-PRIVATE-VALUE";
        throw new OnePasswordAuthError("no token", "no_token");
      },
    };

    // The row after the move: owned by user-b, who now prompts the session.
    await api.providers.db.insert(teams).values({ id: "team-1", orgId: "local-org", name: "Test team", createdAt: Date.now() }).onConflictDoNothing();
    await api.providers.db.insert(agentSessions).values({
      id: "sess-moved-1",
      userId: "user-b",
      orgId: "local-org",
      workspace: "/workspace",
      ownerType: "user",
      ownerId: "user-b",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    // The token minted before the move still carries user-a.
    const { token } = await mintSandboxToken(api.providers.db, {
      sessionId: "sess-moved-1",
      userId: "user-a",
      orgId: "local-org",
    });

    const res = await resolve(["op://ok/item/field"], token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Resp;
    expect(scopesTried).toEqual(["org"]);
    expect(body.values[0]).toBeNull();
  });

  // `owner_id` carries a DEFAULT '', and rows predating the owner columns
  // still hold it. Such a row is owned by its `user_id`, so requiring a
  // populated `owner_id` would take the personal scope away from every
  // session created before those columns were filled in.
  it("a legacy user-owned row with an empty owner_id still reaches the personal vault", async () => {
    api = await bootTestApi();
    const scopesTried: string[] = [];
    api.providers.onePassword = {
      ...fakeOnePassword(),
      resolveReference: async (scope: string) => {
        scopesTried.push(scope);
        if (scope === "personal") return "PERSONAL-VAULT-VALUE";
        throw new OnePasswordAuthError("no token", "no_token");
      },
    };

    await api.providers.db.insert(teams).values({ id: "team-1", orgId: "local-org", name: "Test team", createdAt: Date.now() }).onConflictDoNothing();
    await api.providers.db.insert(agentSessions).values({
      id: "sess-legacy-1",
      userId: "user-a",
      orgId: "local-org",
      workspace: "/workspace",
      ownerType: "user",
      ownerId: "",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const { token } = await mintSandboxToken(api.providers.db, {
      sessionId: "sess-legacy-1",
      userId: "user-a",
      orgId: "local-org",
    });

    const res = await resolve(["op://ok/item/field"], token);
    const body = (await res.json()) as Resp;
    expect(scopesTried).toEqual(["org", "personal"]);
    expect(decode(body.values[0])).toBe("PERSONAL-VAULT-VALUE");
  });

  it("values are positional, with null for a reference nothing resolved", async () => {
    api = await bootTestApi();
    api.providers.onePassword = fakeOnePassword();

    // The shell CLI reads this array by position. Keying by reference meant a
    // vault title containing a quote never matched its own JSON-escaped form.
    const res = await resolve(["op://nope/a/b", "op://ok/c/d"]);
    const body = (await res.json()) as Resp;
    expect(body.values[0]).toBeNull();
    expect(decode(body.values[1])).toBe("secret-for-op://ok/c/d");
  });
  // `ownerType` is user, team, or org. Personal scope belongs to a user-owned
  // session alone; every other owner can be prompted by people other than the
  // frozen actor, so their reads stay on the org token.
  it("an org-owned session never reaches the frozen actor's personal vault", async () => {
    api = await bootTestApi();
    const scopesTried: string[] = [];
    api.providers.onePassword = {
      ...fakeOnePassword(),
      resolveReference: async (scope) => {
        scopesTried.push(scope);
        if (scope === "personal") return "PERSONAL-VAULT-VALUE";
        throw new OnePasswordAuthError("no org token", "no_token");
      },
    };
    await api.providers.db.insert(teams).values({ id: "team-1", orgId: "local-org", name: "Test team", createdAt: Date.now() }).onConflictDoNothing();
    await api.providers.db.insert(agentSessions).values({
      id: "sess-org-1",
      userId: "user-a",
      orgId: "local-org",
      workspace: "/workspace",
      ownerType: "org",
      ownerId: "local-org",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const { token } = await mintSandboxToken(api.providers.db, { sessionId: "sess-org-1", userId: "user-a", orgId: "local-org" });
    const res = await resolve(["op://ok/item/field"], token);
    const body = (await res.json()) as Resp;
    expect(scopesTried).toEqual(["org"]);
    expect(body.values[0]).toBeNull();
  });

  it("a token for a session with no row gets the org scope only", async () => {
    api = await bootTestApi();
    const scopesTried: string[] = [];
    api.providers.onePassword = {
      ...fakeOnePassword(),
      resolveReference: async (scope) => {
        scopesTried.push(scope);
        throw new OnePasswordAuthError("no token", "no_token");
      },
    };
    // `mintToken()` names a session id no row was written for.
    await resolve(["op://ok/item/field"]);
    expect(scopesTried).toEqual(["org"]);
  });

  it("accepts the four-segment section form the SDK accepts", async () => {
    api = await bootTestApi();
    api.providers.onePassword = fakeOnePassword();
    const res = await resolve(["op://ok/GitHub/Tokens/pat"]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Resp;
    expect(decode(body.values[0])).toBe("secret-for-op://ok/GitHub/Tokens/pat");
  });

  // A token that exists and is refused is not "nothing resolved": reporting it
  // that way sent the reader to check vault names that were correct.
  it("surfaces a 1Password refusal instead of reporting the reference as missing", async () => {
    api = await bootTestApi();
    api.providers.onePassword = {
      ...fakeOnePassword(),
      resolveReference: async () => {
        throw new OnePasswordAuthError("1Password request failed", "sdk");
      },
    };
    const res = await resolve(["op://ok/item/field"]);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Check the service account token");
  });

  // A reference the token cannot read is NOT a refused token. The real SDK
  // reports an unknown vault or item this way, and reporting it as a token
  // problem sent the reader to rotate a service account that was fine. The
  // fake used above throws `no_token` for an unknown reference, so only the
  // live SDK showed this; the kind is what the route reads.
  // `--scope` NARROWS the owner rule, never widens it. A team-owned session
  // asking for the personal scope is refused by name, because answering
  // "nothing resolved" would send the reader to check vault names that were
  // correct.
  it("refuses a scope the owner rule excludes, and names why", async () => {
    api = await bootTestApi();
    api.providers.onePassword = fakeOnePassword();
    await api.providers.db.insert(teams).values({ id: "team-1", orgId: "local-org", name: "Test team", createdAt: Date.now() }).onConflictDoNothing();
    await api.providers.db.insert(agentSessions).values({
      id: "sess-scope-team",
      userId: "local-user",
      orgId: "local-org",
      workspace: "/workspace",
      ownerType: "team",
      ownerId: "team-1",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const { token } = await mintSandboxToken(api.providers.db, {
      sessionId: "sess-scope-team",
      userId: "local-user",
      orgId: "local-org",
    });
    const res = await fetch(`${api.baseUrl}/api/sandbox-secrets/resolve`, {
      method: "POST",
      headers: { ...HEADERS, "x-valet-sandbox": token },
      body: JSON.stringify({ references: ["op://ok/item/field"], scope: "personal" }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain("cannot use a personal 1Password token");
  });

  it("rejects an unknown scope", async () => {
    api = await bootTestApi();
    api.providers.onePassword = fakeOnePassword();
    const res = await fetch(`${api.baseUrl}/api/sandbox-secrets/resolve`, {
      method: "POST",
      headers: { ...HEADERS, "x-valet-sandbox": await mintToken() },
      body: JSON.stringify({ references: ["op://ok/item/field"], scope: "nope" }),
    });
    expect(res.status).toBe(403);
  });

  // find returns NAMES. A value in this response would be the one thing that
  // separates it from /resolve.
  it("find returns scope-tagged references as text, never a value", async () => {
    api = await bootTestApi();
    api.providers.onePassword = {
      ...fakeOnePassword(),
      findCandidates: async () => [{ vault: "ProDex Labs", item: "Claude API Key", field: "notesPlain" }],
    };
    const res = await fetch(`${api.baseUrl}/api/sandbox-secrets/find`, {
      method: "POST",
      headers: { ...HEADERS, "x-valet-sandbox": await mintToken() },
      body: JSON.stringify({ query: "claude" }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe("org\top://ProDex Labs/Claude API Key/notesPlain");
  });

  it("find refuses a blank query rather than listing the vaults", async () => {
    api = await bootTestApi();
    api.providers.onePassword = fakeOnePassword();
    for (const query of ["", "   ", undefined]) {
      const res = await fetch(`${api.baseUrl}/api/sandbox-secrets/find`, {
        method: "POST",
        headers: { ...HEADERS, "x-valet-sandbox": await mintToken() },
        body: JSON.stringify({ query }),
      });
      expect(res.status, `query ${JSON.stringify(query)}`).toBe(400);
    }
  });

  it("names an unresolvable reference instead of blaming the token", async () => {
    api = await bootTestApi();
    api.providers.onePassword = {
      ...fakeOnePassword(),
      resolveReference: async () => {
        throw new OnePasswordAuthError("1Password request failed", "reference");
      },
    };
    const res = await resolve(["op://typo/item/field"]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Resp;
    expect(body.values[0]).toBeNull();
    expect(body.unresolved).toEqual(["op://typo/item/field"]);
  });
});

describe("team token scope boundaries", () => {
  async function teamSession() {
    api = await bootTestApi();
    await api.providers.db.insert(teams).values({ id: "team-scope", orgId: "local-org", name: "Scope", createdAt: Date.now() });
    await api.providers.db.insert(agentSessions).values({
      id: "team-scope-session", userId: "local-user", orgId: "local-org", workspace: "/workspace",
      ownerType: "team", ownerId: "team-scope", createdAt: Date.now(), updatedAt: Date.now(),
    });
    return mintToken("team-scope-session");
  }

  it("discovers and resolves with the trusted team identity and ignores legacy refs", async () => {
    const token = await teamSession();
    const calls: string[] = [];
    api!.providers.onePassword = {
      ...fakeOnePassword(),
      findCandidates: async (scope, ctx) => {
        calls.push(scope);
        expect(ctx.teamId).toBe("team-scope");
        return [{ vault: "Allowed", item: "Linear", field: "token" }, { vault: "Allowed", item: "Linear API", field: "token" }];
      },
      resolveReference: async (scope, ctx) => {
        calls.push(scope);
        expect(ctx.teamId).toBe("team-scope");
        return "fake-resolved";
      },
    };
    await api!.providers.engineCredentials.save({ type: "team", id: "team-scope" }, "onepassword", {
      type: "service_account", metadata: { refs: ["op://Old/Item/token"] },
    });
    const found = await fetch(`${api!.baseUrl}/api/sandbox-secrets/find`, {
      method: "POST", headers: { ...HEADERS, "x-valet-sandbox": token }, body: JSON.stringify({ query: "linear", teamId: "attacker-supplied-team" }),
    });
    expect(found.status).toBe(200);
    expect(await found.text()).toBe("team\top://Allowed/Linear/token\nteam\top://Allowed/Linear API/token");
    expect((await resolve(["op://Allowed/Linear/token"], token)).status).toBe(200);
    expect(calls).toEqual(["team", "team"]);
  });

  it("does not broaden an empty team search or a refused team reference to org", async () => {
    const token = await teamSession();
    const calls: string[] = [];
    api!.providers.onePassword = {
      ...fakeOnePassword(),
      findCandidates: async (scope) => { calls.push(scope); return []; },
      resolveReference: async (scope) => {
        calls.push(scope);
        if (scope === "org") return "broader-org-secret";
        throw new OnePasswordAuthError("inaccessible vault", "reference");
      },
    };
    const found = await fetch(`${api!.baseUrl}/api/sandbox-secrets/find`, {
      method: "POST", headers: { ...HEADERS, "x-valet-sandbox": token }, body: JSON.stringify({ query: "missing" }),
    });
    expect(found.status).toBe(200);
    expect(await found.text()).toBe("");
    expect((await resolve(["op://Forbidden/Item/token"], token)).status).toBe(502);
    expect(calls).toEqual(["team", "team"]);
    const explicitOrg = await fetch(`${api!.baseUrl}/api/sandbox-secrets/resolve`, {
      method: "POST", headers: { ...HEADERS, "x-valet-sandbox": token }, body: JSON.stringify({ references: ["op://Org/Item/token"], scope: "org" }),
    });
    expect(explicitOrg.status).toBe(200);
    expect(calls).toEqual(["team", "team", "org"]);
  });

  it("only absent team tokens fall back; a configured team SDK failure refuses find and resolve", async () => {
    const token = await teamSession();
    for (const kind of ["no_token", "sdk"] as const) {
      const calls: string[] = [];
      api!.providers.onePassword = {
        ...fakeOnePassword(),
        findCandidates: async (scope) => {
          calls.push(scope);
          if (scope === "team") throw new OnePasswordAuthError("fake failure", kind);
          return [{ vault: "Org", item: "Item", field: "token" }];
        },
        resolveReference: async (scope) => {
          calls.push(scope);
          if (scope === "team") throw new OnePasswordAuthError("fake failure", kind);
          return "fake-org-value";
        },
      };
      const found = await fetch(`${api!.baseUrl}/api/sandbox-secrets/find`, {
        method: "POST", headers: { ...HEADERS, "x-valet-sandbox": token }, body: JSON.stringify({ query: "item" }),
      });
      expect(found.status).toBe(kind === "no_token" ? 200 : 502);
      expect((await resolve(["op://Org/Item/token"], token)).status).toBe(kind === "no_token" ? 200 : 502);
      expect(calls).toEqual(kind === "no_token" ? ["team", "org", "team", "org"] : ["team", "team"]);
    }
  });

  it("refuses personal sessions requesting team scope", async () => {
    api = await bootTestApi();
    api.providers.onePassword = { ...fakeOnePassword(), findCandidates: async () => { throw new Error("must not call SDK"); } };
    const token = await mintToken();
    for (const path of ["find", "resolve"]) {
      const response = await fetch(`${api.baseUrl}/api/sandbox-secrets/${path}`, {
        method: "POST", headers: { ...HEADERS, "x-valet-sandbox": token },
        body: JSON.stringify({ query: "linear", references: ["op://Team/Item/token"], scope: "team", teamId: "team-scope" }),
      });
      expect(response.status).toBe(403);
    }
  });
});

// ── Per-engagement allowlist (Part 12 §Broker allowlist enforcement, INV-34) ──
//
// A security persona's child sandbox is claimed by a `security_cells` row
// (`childSessionId`). When that claim exists, the broker refuses any
// reference the engagement did not declare in `credentials_json`, before it
// ever calls `resolveReference`. Every other caller (a coding session, an
// orchestrator, a workflow sandbox) claims no cell and is unaffected.
describe("POST /api/sandbox-secrets/resolve allowlist (INV-34)", () => {
  let engagementCounter = 0;

  async function seedEngagement(
    credentialsJson: unknown,
    overrides: Partial<typeof securityEngagements.$inferInsert> = {},
  ): Promise<{ engagementId: string; sessionId: string }> {
    engagementCounter += 1;
    const engagementId = `eng-allow-${engagementCounter}`;
    const sessionId = `eng-allow-${engagementCounter}-session`;
    await api!.providers.db.insert(securityEngagements).values({
      id: engagementId,
      sessionId,
      repoFullName: "acme/widgets",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      credentialsJson,
      status: "running",
      ...overrides,
    });
    return { engagementId, sessionId };
  }

  async function claimWithCell(engagementId: string, childSessionId: string): Promise<void> {
    await api!.providers.db.insert(securityCells).values({
      id: `${childSessionId}-cell`,
      engagementId,
      ordinal: 0,
      persona: "code-review",
      goal: "test cell",
      dir: "01-recon",
      childSessionId,
      status: "running",
      createdAt: Date.now(),
    });
  }

  async function find(query: string, token: string): Promise<Response> {
    return fetch(`${api!.baseUrl}/api/sandbox-secrets/find`, {
      method: "POST",
      headers: { ...HEADERS, "x-valet-sandbox": token },
      body: JSON.stringify({ query }),
    });
  }

  it("allows a reference on the engagement's declared list", async () => {
    api = await bootTestApi();
    api.providers.onePassword = fakeOnePassword();
    const { engagementId } = await seedEngagement([
      { label: "admin", kind: "headerToken", env: "ADMIN", reference: "op://ok/Admin/password" },
    ]);
    const childSessionId = "sess-allow-1";
    await claimWithCell(engagementId, childSessionId);
    const token = await mintToken(childSessionId);

    const res = await resolve(["op://ok/Admin/password"], token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Resp;
    expect(decode(body.values[0])).toBe("secret-for-op://ok/Admin/password");
  });

  it("allows an mTLS certificate reference declared in meta.certRef", async () => {
    api = await bootTestApi();
    api.providers.onePassword = fakeOnePassword();
    const { engagementId } = await seedEngagement([
      {
        label: "partner",
        kind: "mtls",
        env: "CLIENT_KEY",
        reference: "op://ok/Partner/key",
        meta: { certRef: "op://ok/Partner/cert" },
      },
    ]);
    const childSessionId = "sess-allow-mtls";
    await claimWithCell(engagementId, childSessionId);
    const res = await resolve(
      ["op://ok/Partner/key", "op://ok/Partner/cert"],
      await mintToken(childSessionId),
    );
    expect(res.status).toBe(200);
  });

  it("refuses a reference not on the engagement's declared list, naming it", async () => {
    api = await bootTestApi();
    api.providers.onePassword = fakeOnePassword();
    const { engagementId } = await seedEngagement([
      { label: "admin", kind: "headerToken", env: "ADMIN", reference: "op://ok/Admin/password" },
    ]);
    const childSessionId = "sess-allow-2";
    await claimWithCell(engagementId, childSessionId);
    const token = await mintToken(childSessionId);

    const res = await resolve(["op://ok/Other/password"], token);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.error).toContain("op://ok/Other/password");
    expect(body.code).toBe("credential_ref_not_allowlisted");
  });

  it("never calls resolveReference for a refused reference (checked before resolution)", async () => {
    api = await bootTestApi();
    const calls: string[] = [];
    api.providers.onePassword = {
      ...fakeOnePassword(),
      resolveReference: async (scope, ctx, reference) => {
        calls.push(reference);
        return `secret-for-${reference}`;
      },
    };
    const { engagementId } = await seedEngagement([
      { label: "admin", kind: "headerToken", env: "ADMIN", reference: "op://ok/Admin/password" },
    ]);
    const childSessionId = "sess-allow-3";
    await claimWithCell(engagementId, childSessionId);
    const token = await mintToken(childSessionId);

    const res = await resolve(["op://ok/Other/password"], token);
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("bypasses the allowlist for a session no security cell claims", async () => {
    api = await bootTestApi();
    api.providers.onePassword = fakeOnePassword();
    // No security_engagements / security_cells row names this session at
    // all: a plain coding session, orchestrator, or workflow sandbox.
    const token = await mintToken("sess-allow-bypass");

    const res = await resolve(["op://ok/Any/pw"], token);
    expect(res.status).toBe(200);
  });

  it.each([
    ["null", null],
    ["an empty list", []],
  ])("refuses every reference when the engagement declares %s", async (_name, credentialsJson) => {
    api = await bootTestApi();
    api.providers.onePassword = fakeOnePassword();
    const { engagementId } = await seedEngagement(credentialsJson);
    const childSessionId = "sess-allow-4";
    await claimWithCell(engagementId, childSessionId);
    const token = await mintToken(childSessionId);

    const res = await resolve(["op://ok/Admin/password"], token);
    expect(res.status).toBe(403);
  });

  it("matches a declared reference case-sensitively", async () => {
    api = await bootTestApi();
    api.providers.onePassword = fakeOnePassword();
    const { engagementId } = await seedEngagement([
      { label: "admin", kind: "headerToken", env: "ADMIN", reference: "op://ok/Admin/Password" },
    ]);
    const childSessionId = "sess-allow-6";
    await claimWithCell(engagementId, childSessionId);
    const token = await mintToken(childSessionId);

    // Same reference, different case on the last two segments: must not
    // match the declared entry.
    const res = await resolve(["op://ok/admin/password"], token);
    expect(res.status).toBe(403);

    const exact = await resolve(["op://ok/Admin/Password"], token);
    expect(exact.status).toBe(200);
  });

  it("names only the refused reference, not the rest of the declared list", async () => {
    api = await bootTestApi();
    api.providers.onePassword = fakeOnePassword();
    const { engagementId } = await seedEngagement([
      { label: "admin", kind: "headerToken", env: "ADMIN", reference: "op://ok/Admin/password" },
      { label: "signer", kind: "signingKey", env: "SIGNER", reference: "op://ok/Signer/key" },
    ]);
    const childSessionId = "sess-allow-7";
    await claimWithCell(engagementId, childSessionId);
    const token = await mintToken(childSessionId);

    const res = await resolve(["op://ok/Admin/password", "op://ok/Other/password"], token);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("op://ok/Other/password");
    // The response never lists the other declared references.
    expect(body.error).not.toContain("op://ok/Admin/password");
    expect(body.error).not.toContain("op://ok/Signer/key");
  });

  it("skips malformed declared entries instead of matching everything", async () => {
    api = await bootTestApi();
    api.providers.onePassword = fakeOnePassword();
    const { engagementId } = await seedEngagement([
      { label: "no-reference-field" },
      "junk",
      { label: "admin", kind: "headerToken", env: "ADMIN", reference: "op://ok/Admin/password" },
    ]);
    const childSessionId = "sess-allow-8";
    await claimWithCell(engagementId, childSessionId);
    const token = await mintToken(childSessionId);

    const allowed = await resolve(["op://ok/Admin/password"], token);
    expect(allowed.status).toBe(200);

    const refused = await resolve(["op://ok/Other/password"], token);
    expect(refused.status).toBe(403);
  });

  it("allows discovery from the current running persona cell", async () => {
    api = await bootTestApi();
    api.providers.onePassword = fakeOnePassword();
    const { engagementId } = await seedEngagement([]);
    const childSessionId = "sess-find-running-cell";
    await claimWithCell(engagementId, childSessionId);

    expect((await find("admin", await mintToken(childSessionId))).status).toBe(200);
  });

  it("refuses discovery from a settled persona cell", async () => {
    api = await bootTestApi();
    api.providers.onePassword = fakeOnePassword();
    const { engagementId } = await seedEngagement([]);
    const childSessionId = "sess-find-settled-cell";
    await claimWithCell(engagementId, childSessionId);
    await api.providers.db
      .update(securityCells)
      .set({ status: "completed" })
      .where(eq(securityCells.childSessionId, childSessionId));

    expect((await find("admin", await mintToken(childSessionId))).status).toBe(403);
  });

  it("refuses discovery from a replaced child", async () => {
    api = await bootTestApi();
    api.providers.onePassword = fakeOnePassword();
    const { sessionId: runnerSessionId } = await seedEngagement([]);
    const staleChild = "sess-find-replaced-cell";
    await api.providers.db.insert(childWatches).values({
      childSessionId: staleChild,
      queueItemId: "q-find-stale",
      parentSessionId: runnerSessionId,
      parentThreadId: "main",
      actorUserId: "local-user",
      orgId: "local-org",
      createdAt: Date.now(),
    });

    expect((await find("admin", await mintToken(staleChild))).status).toBe(403);
  });

  it("refuses discovery from the engagement runner", async () => {
    api = await bootTestApi();
    api.providers.onePassword = fakeOnePassword();
    const { sessionId } = await seedEngagement([]);

    const refused = await find("admin", await mintToken(sessionId));
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toContain(
      "Only a running security persona cell",
    );
  });

  it("refuses a settled persona cell", async () => {
    api = await bootTestApi();
    api.providers.onePassword = fakeOnePassword();
    const { engagementId } = await seedEngagement([
      { label: "admin", kind: "headerToken", env: "ADMIN", reference: "op://ok/Admin/password" },
    ]);
    const childSessionId = "sess-settled-cell";
    await claimWithCell(engagementId, childSessionId);
    await api.providers.db
      .update(securityCells)
      .set({ status: "completed" })
      .where(eq(securityCells.childSessionId, childSessionId));

    expect((await resolve(["op://ok/Admin/password"], await mintToken(childSessionId))).status).toBe(403);
  });

  it("refuses a replaced child whose watch still points at the security runner", async () => {
    api = await bootTestApi();
    api.providers.onePassword = fakeOnePassword();
    const { sessionId: runnerSessionId } = await seedEngagement([
      { label: "admin", kind: "headerToken", env: "ADMIN", reference: "op://ok/Admin/password" },
    ]);
    const staleChild = "sess-replaced-cell";
    await api.providers.db.insert(childWatches).values({
      childSessionId: staleChild,
      queueItemId: "q-stale",
      parentSessionId: runnerSessionId,
      parentThreadId: "main",
      actorUserId: "local-user",
      orgId: "local-org",
      createdAt: Date.now(),
    });

    expect((await resolve(["op://ok/Admin/password"], await mintToken(staleChild))).status).toBe(403);
  });

  it("refuses the engagement's top-level runner session", async () => {
    api = await bootTestApi();
    api.providers.onePassword = fakeOnePassword();
    // No cell claim exists: runners coordinate cells but may not resolve
    // persona credentials themselves.
    const { sessionId } = await seedEngagement([
      { label: "admin", kind: "headerToken", env: "ADMIN", reference: "op://ok/Admin/password" },
    ]);
    const token = await mintToken(sessionId);

    const refused = await resolve(["op://ok/Admin/password"], token);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toContain(
      "Only a running security persona cell",
    );
  });
});
