import { describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "@valet/engine";
import { createOnePasswordService, OnePasswordAuthError, type OpClient } from "./onepassword.js";
import { onePasswordScopesFor, resolveTeamCredentialRead, resolveUserCredentialRead } from "./credential-resolution.js";

const ctx = { orgId: "org", teamId: "team", userId: "user" };
const reference = "op://Team/Linear/token";
function fixture() {
  const credentials = new InMemoryCredentialStore();
  const clients: string[] = [];
  let duplicate = false;
  const getWithSecrets = vi.fn(async () => ({ title: "Linear", fields: [{ title: "token", fieldType: "Concealed", value: "fake-value" }] }));
  const onePassword = createOnePasswordService({
    credentials, getAllowPersonal: async () => true,
    createClient: async (token): Promise<OpClient> => {
      clients.push(token);
      if (token === "fake-revoked") throw new Error("fake-sensitive-upstream-text");
      return {
        secrets: { resolve: async (ref) => {
          if (ref.includes("Forbidden")) throw new Error("fake-denied");
          return `${token}-value`;
        } },
        vaults: { list: async () => [{ id: "v", title: "Team" }] },
        items: {
          list: async () => duplicate
            ? [{ id: "i", title: "Linear", vaultId: "v" }, { id: "j", title: "Linear API", vaultId: "v" }]
            : [{ id: "i", title: "Linear", vaultId: "v" }],
          getWithSecrets,
        },
      };
    },
  });
  const token = (type: "team" | "org" | "user", id: string, value: string) =>
    credentials.save({ type, id }, "onepassword", { type: "service_account", apiKey: value });
  return { credentials, onePassword, clients, token, getWithSecrets, duplicate: () => { duplicate = true; } };
}

describe("team service account resolution", () => {
  it("uses the trusted team owner, isolates teams, and observes rotation and deletion immediately", async () => {
    const f = fixture();
    await f.token("team", "team", "fake-a");
    await f.token("team", "other", "fake-b");
    expect(await f.onePassword.resolveReference("team", ctx, reference)).toBe("fake-a-value");
    expect(await f.onePassword.resolveReference("team", { ...ctx, teamId: "other" }, reference)).toBe("fake-b-value");
    await f.token("team", "team", "fake-c");
    expect(await f.onePassword.resolveReference("team", ctx, reference)).toBe("fake-c-value");
    await f.credentials.delete({ type: "team", id: "team" }, "onepassword");
    await expect(f.onePassword.resolveReference("team", ctx, reference)).rejects.toMatchObject({ kind: "no_token" });
    await expect(f.onePassword.resolveReference("team", { orgId: "org", userId: "user" }, reference)).rejects.toMatchObject({ kind: "scope" });
  });

  it("preserves explicit org references even with a broken team token and obsolete refs", async () => {
    const f = fixture();
    await f.token("org", "org", "fake-org");
    await f.credentials.save({ type: "team", id: "team" }, "onepassword", {
      type: "service_account", apiKey: "fake-revoked", metadata: { refs: ["op://Obsolete/Other/token"] },
    });
    await f.credentials.save({ type: "team", id: "team" }, "linear", {
      type: "api_key", metadata: { onepassword: { reference, tokenScope: "org" } },
    });
    expect(await resolveTeamCredentialRead(f, ctx, "linear", "reference-only")).toMatchObject({ apiKey: "fake-org-value" });
    expect(f.clients).toEqual(["fake-org"]);
  });

  it("discovers with team, using org only when the team token is absent", async () => {
    const f = fixture();
    await f.token("org", "org", "fake-org");
    await f.credentials.save({ type: "team", id: "team" }, "onepassword", { type: "service_account", metadata: { refs: ["op://Old/Item/field"] } });
    expect(await resolveTeamCredentialRead(f, ctx, "linear", "reference-only")).toMatchObject({ apiKey: "fake-value" });
    expect(f.clients).toEqual(["fake-org"]);
    await f.token("team", "team", "fake-team");
    f.clients.length = 0;
    expect(await resolveTeamCredentialRead(f, ctx, "linear", "reference-only")).toMatchObject({ apiKey: "fake-value" });
    expect(f.clients).toEqual(["fake-team"]);
    expect(await resolveTeamCredentialRead(f, ctx, "missing-service", "reference-only")).toBeNull();
  });

  it("does not substitute an org match after a configured team miss", async () => {
    const f = fixture();
    const lookup = vi.spyOn(f.onePassword, "findCredentialForService").mockImplementation(async (scope) => scope === "org" ? "broader-org-value" : null);
    expect(await resolveTeamCredentialRead(f, ctx, "linear", "reference-only")).toBeNull();
    expect(lookup.mock.calls.map(([scope]) => scope)).toEqual(["team"]);
  });

  it("does not replace a configured failed team token with org credentials or log upstream secrets", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const f = fixture();
      await f.token("team", "team", "fake-revoked");
      await f.token("org", "org", "fake-org");
      await expect(resolveTeamCredentialRead(f, ctx, "linear", "reference-only")).rejects.toBeInstanceOf(OnePasswordAuthError);
      expect(f.clients).toEqual(["fake-revoked"]);
      expect(JSON.stringify(log.mock.calls)).not.toContain("fake-sensitive-upstream-text");
      expect(JSON.stringify(log.mock.calls)).not.toContain("fake-revoked");
    } finally { log.mockRestore(); }
  });

  it("personal and unknown owners never discover team vaults", async () => {
    const f = fixture();
    await f.token("team", "team", "fake-team");
    expect(onePasswordScopesFor("user", "team")).toEqual(["org", "personal"]);
    expect(onePasswordScopesFor(undefined, "team")).toEqual(["org"]);
    expect(onePasswordScopesFor("team")).toEqual(["org"]);
    expect(await resolveUserCredentialRead(f, { ...ctx, scopes: onePasswordScopesFor("user") }, "linear", "reference-only")).toBeNull();
    expect(f.clients).toEqual([]);
  });

  it("find exposes candidates, refuses inaccessible references, and requires selection for ambiguous service lookup", async () => {
    const f = fixture();
    await f.token("team", "team", "fake-team");
    f.duplicate();
    const candidates = await f.onePassword.findCandidates("team", ctx, "linear");
    expect(candidates).toHaveLength(2);
    expect(candidates.every((candidate) => !("value" in candidate))).toBe(true);
    f.getWithSecrets.mockClear();
    await expect(resolveTeamCredentialRead(f, ctx, "linear", "reference-only")).rejects.toMatchObject({ kind: "ambiguous", message: expect.stringContaining("explicit scope and reference") });
    expect(f.getWithSecrets).not.toHaveBeenCalled();
    await expect(f.onePassword.resolveReference("team", ctx, "op://Forbidden/Item/token")).rejects.toMatchObject({ kind: "reference" });
  });
});

describe("duplicate 1Password titles", () => {
  it("find returns distinct ID references that resolve the selected item", async () => {
    const credentials = new InMemoryCredentialStore();
    await credentials.save({ type: "team", id: "team" }, "onepassword", { type: "service_account", apiKey: "fake" });
    const sentinels: Record<string, string> = { "op://v1/i1/token": "sentinel-1", "op://v1/i2/token": "sentinel-2", "op://v2/Linear/token": "sentinel-3" };
    const svc = createOnePasswordService({
      credentials, getAllowPersonal: async () => true,
      createClient: async () => ({
        vaults: { list: async () => [{ id: "v1", title: "Same" }, { id: "v2", title: "Same" }] },
        items: {
          list: async (vaultId) => vaultId === "v1"
            ? [{ vaultId, id: "i1", title: "Linear" }, { vaultId, id: "i2", title: "Linear" }]
            : [{ vaultId, id: "i3", title: "Linear" }],
          getWithSecrets: async () => ({ title: "Linear", fields: [{ title: "token", fieldType: "Concealed", value: "fake" }] }),
        },
        secrets: { resolve: async (ref) => {
          const value = sentinels[ref];
          if (!value) throw new Error("ambiguous reference");
          return value;
        } },
      }),
    });
    const hits = await svc.findCandidates("team", ctx, "linear");
    const refs = hits.map((hit) => `op://${hit.vault}/${hit.item}/${hit.field}`);
    expect(refs).toEqual(Object.keys(sentinels));
    expect(await Promise.all(refs.map((ref) => svc.resolveReference("team", ctx, ref)))).toEqual(Object.values(sentinels));
    expect(await svc.findCandidates("team", ctx, "linear", 1)).toEqual([hits[0]]);
    await expect(svc.findCredentialForService("team", ctx, "linear")).rejects.toMatchObject({ kind: "ambiguous" });
  });
});
