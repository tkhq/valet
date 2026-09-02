// @vitest-environment node
/**
 * The broker route: what a sandbox CLI is allowed to ask for, and what it
 * gets back when it asks for something silly.
 */
import { afterEach, describe, expect, it } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { mintSandboxToken } from "../auth/sandbox-tokens.js";
import { agentSessions } from "../schema/index.js";
import { OnePasswordAuthError, type OnePasswordService } from "../services/onepassword.js";
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
    listItems: unused,
    getItem: unused,
    findCredentialForService: async () => null,
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
    // "ProDex Labs" is an ordinary vault name. An earlier `[^\s]+` pattern
    // rejected every reference into a vault with a space in its title.
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
  // The CLI's only credential is the sandbox token. The route used to read
  // `c.var.user`, which the sandbox rung never sets: every real CLI call
  // threw, and the CLI reported it as "nothing resolved".
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
        throw new Error("no org token");
      },
    };

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
    expect(scopesTried).toEqual(["org"]);
    expect(body.values[0]).toBeNull();
    expect(body.unresolved).toEqual(["op://ok/item/field"]);
  });

  it("a user-owned session still reaches that user's personal vault", async () => {
    api = await bootTestApi();
    const scopesTried: string[] = [];
    api.providers.onePassword = {
      ...fakeOnePassword(),
      resolveReference: async (scope: string) => {
        scopesTried.push(scope);
        if (scope === "personal") return "PERSONAL-VAULT-VALUE";
        throw new Error("no org token");
      },
    };

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
});
