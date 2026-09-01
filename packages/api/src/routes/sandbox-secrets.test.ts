// @vitest-environment node
/**
 * The broker route: what a sandbox CLI is allowed to ask for, and what it
 * gets back when it asks for something silly.
 */
import { afterEach, describe, expect, it } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { mintSandboxToken } from "../auth/sandbox-tokens.js";
import { agentSessions } from "../schema/index.js";
import type { OnePasswordService } from "../services/onepassword.js";

let api: TestApi | undefined;
afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

/** Resolves anything under `op://ok/`, refuses the rest. */
function fakeOnePassword(): OnePasswordService {
  const unused = () => {
    throw new Error("not exercised by this suite");
  };
  return {
    tokenConnected: unused,
    listVaults: unused,
    listItems: unused,
    getItem: unused,
    findCredentialForService: async () => null,
    resolveCredential: async (row: unknown) => row,
    resolveReference: async (_scope: string, _ctx: unknown, reference: string) => {
      if (!reference.startsWith("op://ok/")) throw new Error("no such item");
      return `secret-for-${reference}`;
    },
  } as unknown as OnePasswordService;
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
function decode(body: { resolvedBase64: Record<string, string> }, reference: string): string | undefined {
  const encoded = body.resolvedBase64[reference];
  return encoded === undefined ? undefined : Buffer.from(encoded, "base64").toString("utf8");
}

describe("POST /api/sandbox-secrets/resolve", () => {
  it("resolves the references it can and names the ones it cannot", async () => {
    api = await bootTestApi();
    api.providers.onePassword = fakeOnePassword();

    const res = await resolve(["op://ok/item/field", "op://nope/item/field"]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resolvedBase64: Record<string, string>; unresolved: string[] };

    expect(decode(body, "op://ok/item/field")).toBe("secret-for-op://ok/item/field");
    // Named, not thrown: the CLI decides whether a miss is fatal, and can say
    // WHICH reference failed.
    expect(body.unresolved).toEqual(["op://nope/item/field"]);
    // A reference nobody resolved carries no value and no reason — the reason
    // would describe someone else's vault.
    expect(decode(body, "op://nope/item/field")).toBeUndefined();
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
    const body = (await res.json()) as { resolvedBase64: Record<string, string> };
    expect(decode(body, "op://ok/JumpCloud Login/password")).toBeTruthy();
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
    const body = (await res.json()) as { resolvedBase64: Record<string, string> };
    expect(decode(body, "op://ok/item/field")).toBe("secret-for-op://ok/item/field");
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
    } as unknown as typeof api.providers.onePassword;

    const res = await resolve(["op://ok/item/field"]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resolvedBase64: Record<string, string> };
    // The old byte-level extractor cut this at the first quote and never
    // unescaped, so a private key arrived corrupted but plausible.
    expect(decode(body, "op://ok/item/field")).toBe(nasty);
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
    } as unknown as typeof api.providers.onePassword;

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
    const body = (await res.json()) as { resolvedBase64: Record<string, string>; unresolved: string[] };
    expect(scopesTried).toEqual(["org"]);
    expect(decode(body, "op://ok/item/field")).toBeUndefined();
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
    } as unknown as typeof api.providers.onePassword;

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
    const body = (await res.json()) as { resolvedBase64: Record<string, string> };
    expect(scopesTried).toEqual(["org", "personal"]);
    expect(decode(body, "op://ok/item/field")).toBe("PERSONAL-VAULT-VALUE");
  });

  it("values are positional, with null for a reference nothing resolved", async () => {
    api = await bootTestApi();
    api.providers.onePassword = fakeOnePassword();

    // The shell CLI reads this array by position. Keying by reference meant a
    // vault title containing a quote never matched its own JSON-escaped form.
    const res = await resolve(["op://nope/a/b", "op://ok/c/d"]);
    const body = (await res.json()) as { values: (string | null)[] };
    expect(body.values[0]).toBeNull();
    expect(Buffer.from(body.values[1] as string, "base64").toString("utf8")).toBe("secret-for-op://ok/c/d");
  });
});
