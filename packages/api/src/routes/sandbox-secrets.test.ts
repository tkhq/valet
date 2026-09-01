// @vitest-environment node
/**
 * The broker route: what a sandbox CLI is allowed to ask for, and what it
 * gets back when it asks for something silly.
 */
import { afterEach, describe, expect, it } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
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
    resolveCredential: async (row) => row,
    resolveReference: async (_scope, _ctx, reference) => {
      if (!reference.startsWith("op://ok/")) throw new Error("no such item");
      return `secret-for-${reference}`;
    },
  } as unknown as OnePasswordService;
}

const HEADERS = { "Content-Type": "application/json" };

async function resolve(references: unknown) {
  return fetch(`${api!.baseUrl}/api/sandbox-secrets/resolve`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ references }),
  });
}

describe("POST /api/sandbox-secrets/resolve", () => {
  it("resolves the references it can and names the ones it cannot", async () => {
    api = await bootTestApi();
    api.providers.onePassword = fakeOnePassword();

    const res = await resolve(["op://ok/item/field", "op://nope/item/field"]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resolved: Record<string, string>; unresolved: string[] };

    expect(body.resolved["op://ok/item/field"]).toBe("secret-for-op://ok/item/field");
    // Named, not thrown: the CLI decides whether a miss is fatal, and can say
    // WHICH reference failed.
    expect(body.unresolved).toEqual(["op://nope/item/field"]);
    // A reference nobody resolved carries no value and no reason — the reason
    // would describe someone else's vault.
    expect(body.resolved["op://nope/item/field"]).toBeUndefined();
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
});
