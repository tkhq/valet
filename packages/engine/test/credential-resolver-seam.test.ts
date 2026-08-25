import { describe, it, expect } from "vitest";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
  Engine,
  InMemoryEventStream,
  InMemorySessionStore,
  VirtualSandboxProvider,
  type CredentialOwner,
  type CredentialStore,
  type StoredCredential,
} from "../src/index.js";

/** A minimal in-memory CredentialStore keyed by `${owner.type}:${owner.id}:${service}`. */
function makeStore(seed: Record<string, StoredCredential> = {}): CredentialStore {
  const map = new Map<string, StoredCredential>(Object.entries(seed));
  const key = (o: CredentialOwner, s: string) => `${o.type}:${o.id}:${s}`;
  return {
    async get(owner, service) {
      return map.get(key(owner, service)) ?? null;
    },
    async save(owner, service, cred) {
      map.set(key(owner, service), cred);
    },
    async delete(owner, service) {
      map.delete(key(owner, service));
    },
    async list() {
      return [];
    },
  };
}

function makeEngine(credentials?: CredentialStore) {
  const store = new InMemorySessionStore();
  const bus = new InMemoryEventStream();
  const sandboxProvider = new VirtualSandboxProvider();
  const engine = new Engine({
    providers: { store, stream: bus, sandboxProvider, credentials },
  });
  return { engine };
}

describe("Session.credentialProvider credentialResolver seam", () => {
  it("absent resolver: byte-identical raw store read", async () => {
    const faux = registerFauxProvider({ provider: "cred-seam-1" });
    const credentials = makeStore({
      "user:u1:github": { type: "oauth2", accessToken: "raw-token" },
    });
    const { engine } = makeEngine(credentials);
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: {},
      model: faux.getModel(),
    });

    const provider = session.credentialProvider();
    await expect(provider.get("github")).resolves.toMatchObject({ accessToken: "raw-token" });
    // Unknown service falls through to the store (null), not the resolver.
    await expect(provider.get("nope")).resolves.toBeNull();
    faux.unregister();
  });

  it("resolver present: consulted with (owner, service) and its value REPLACES the store read", async () => {
    const faux = registerFauxProvider({ provider: "cred-seam-2" });
    // Store holds a DIFFERENT token — a passing test proves the resolver, not
    // the store, is the source of truth when a resolver is supplied.
    const credentials = makeStore({
      "user:u1:github": { type: "oauth2", accessToken: "store-token" },
    });
    const seen: Array<{ owner: CredentialOwner; service: string }> = [];
    const { engine } = makeEngine(credentials);
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: {},
      model: faux.getModel(),
      credentialResolver: async (owner, service) => {
        seen.push({ owner, service });
        if (service === "github") return { type: "oauth2", accessToken: "resolved-token" };
        return null;
      },
    });

    const provider = session.credentialProvider();
    await expect(provider.get("github")).resolves.toMatchObject({ accessToken: "resolved-token" });
    expect(seen).toEqual([{ owner: { type: "user", id: "u1" }, service: "github" }]);

    // Resolver returning null yields null with NO store fallback — the store's
    // `demo` credential (absent here) is never consulted.
    seen.length = 0;
    await expect(provider.get("demo")).resolves.toBeNull();
    expect(seen).toEqual([{ owner: { type: "user", id: "u1" }, service: "demo" }]);
    faux.unregister();
  });

  it("resolver present with no store: get() still routes through the resolver", async () => {
    const faux = registerFauxProvider({ provider: "cred-seam-3" });
    const seen: string[] = [];
    const { engine } = makeEngine(undefined);
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: {},
      model: faux.getModel(),
      credentialResolver: async (_owner, service) => {
        seen.push(service);
        return { type: "oauth2", accessToken: "no-store-token" };
      },
    });
    const provider = session.credentialProvider();
    await expect(provider.get("github")).resolves.toMatchObject({ accessToken: "no-store-token" });
    expect(seen).toEqual(["github"]);
    faux.unregister();
  });

  it("resolver that throws propagates out of get() (surfaces as the tool error)", async () => {
    const faux = registerFauxProvider({ provider: "cred-seam-4" });
    const { engine } = makeEngine(makeStore());
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: {},
      model: faux.getModel(),
      credentialResolver: async () => {
        throw new Error("no GitHub credential is available; connect your GitHub account");
      },
    });
    const provider = session.credentialProvider();
    await expect(provider.get("github")).rejects.toThrow(/connect your GitHub account/);
    faux.unregister();
  });
});
