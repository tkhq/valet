// @vitest-environment node
import { describe, expect, it } from "vitest";
import { scrubInboundSecrets } from "./inbound-scrub.js";
import { SecretStoreError } from "./provider.js";
import { secretReference, type SecretStoreService } from "./service.js";

const OPENAI = "sk-proj-" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0";

function fakeStore(opts: { failSave?: boolean; existing?: string[] } = {}) {
  const saved: { name: string; value: string }[] = opts.existing?.map((name) => ({ name, value: "old" })) ?? [];
  const refuse = async (): Promise<never> => {
    throw new Error("not used");
  };
  const store: SecretStoreService = {
    enabled: true,
    providerLabel: "Memory",
    list: async (_a, scope) => saved.map((s) => ({ name: s.name, createdAt: 0, reference: secretReference(scope, s.name) })),
    saveValue: async (_a, scope, name, value) => {
      if (opts.failSave) throw new SecretStoreError("no", "forbidden");
      saved.push({ name, value });
      return { name, createdAt: 0, reference: secretReference(scope, name) };
    },
    beginSave: refuse,
    finishSave: refuse,
    remove: refuse,
    exists: refuse,
    mayRead: refuse,
    read: refuse,
  };
  return { store, saved };
}

const base = { actor: { orgId: "o", userId: "u" }, scope: { kind: "personal" } as const };

describe("scrubInboundSecrets", () => {
  it("saves a known key, replaces it with the reference, and says so", async () => {
    const fake = fakeStore();
    const result = await scrubInboundSecrets({ ...base, store: fake.store, text: `use ${OPENAI} for the script` });
    expect(fake.saved).toEqual([{ name: "OPENAI_API_KEY", value: OPENAI }]);
    expect(result.text).not.toContain(OPENAI);
    expect(result.text).toContain("use secret://personal/OPENAI_API_KEY for the script");
    expect(result.text).toMatch(/Valet saved a key from this message.*rotate it/);
  });

  it("picks a free name when the suggested one is taken", async () => {
    const fake = fakeStore({ existing: ["OPENAI_API_KEY"] });
    const result = await scrubInboundSecrets({ ...base, store: fake.store, text: OPENAI });
    expect(result.saved).toEqual(["secret://personal/OPENAI_API_KEY_2"]);
  });

  it("removes a key it cannot save, and tells a channel user to delete the original", async () => {
    const fake = fakeStore({ failSave: true });
    const result = await scrubInboundSecrets({ ...base, store: fake.store, text: `key ${OPENAI}`, channel: "channel" });
    expect(result.text).not.toContain(OPENAI);
    expect(result.text).toContain("[removed openai key]");
    expect(result.text).toMatch(/delete it there, and rotate the key/);
  });

  it("leaves a message without a known key unchanged, including an assignment", async () => {
    const fake = fakeStore();
    const text = "deploy 3f9a2c1d8e7b6a5f4c3d2e1f0a9b8c7d6e5f4a3b with ACME_TOKEN=q8w7e6r5t4y3u2i1";
    expect(await scrubInboundSecrets({ ...base, store: fake.store, text })).toEqual({ text, saved: [], removed: 0 });
    expect(fake.saved).toEqual([]);
  });
});
