/**
 * `/api/onepassword` — picker-backend routes + org/personal settings
 * (1Password credential provider plan, Task 3). Providers.onePassword is
 * swapped for a `FakeOnePasswordService` post-boot (same pattern
 * `prebuilds.test.ts` uses for `imageBuilder`) so these tests never touch the
 * real `@1password/sdk`.
 */
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import linearPlugin from "@valet/plugin-linear/plugin";
import { orgMembers, users } from "../schema/index.js";
import { OnePasswordAuthError, type OnePasswordCtx, type OnePasswordScope, type OnePasswordService } from "../services/onepassword.js";
import type {
  ListOpItemsResponse,
  ListOpVaultsResponse,
  OnePasswordSettingsResponse,
  OpItemDetailResponse,
} from "../wire/types.js";

const HEADERS = { "Content-Type": "application/json" };
const MEMBER_HEADERS = { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" };

class FakeOnePasswordService implements OnePasswordService {
  orgToken = false;
  personalToken = false;
  vaultsCalls: OnePasswordScope[] = [];

  async tokenConnected(scope: OnePasswordScope): Promise<boolean> {
    return scope === "org" ? this.orgToken : this.personalToken;
  }
  async listVaults(scope: OnePasswordScope, _ctx: OnePasswordCtx) {
    this.vaultsCalls.push(scope);
    if (scope === "org" && !this.orgToken) {
      throw new OnePasswordAuthError("This org has no organization 1Password service account token connected.");
    }
    if (scope === "personal" && !this.personalToken) {
      throw new OnePasswordAuthError("This org has no personal 1Password service account token connected.");
    }
    return [{ id: "vault1", title: "Engineering" }];
  }
  /** Item count is settable so the pagination cases have something to page. */
  itemCount = 1;
  /** Explicit titles, for the suggestion cases that match on them. */
  itemTitles: string[] | undefined;
  /** Vault ids whose listing throws, for the partial-scan case. */
  unreadableVaultIds = new Set<string>();
  async listItems(_scope: unknown, _ctx: unknown, vaultId?: string) {
    if (vaultId && this.unreadableVaultIds.has(vaultId)) {
      throw new OnePasswordAuthError("cannot read this vault");
    }
    if (this.itemTitles) {
      return this.itemTitles.map((title, i) => ({ id: `item${i + 1}`, title, vaultId: "vault1" }));
    }
    return Array.from({ length: this.itemCount }, (_, i) => ({
      id: `item${i + 1}`,
      title: i === 0 ? "Prod DB" : `Item ${i + 1}`,
      vaultId: "vault1",
    }));
  }
  async getItem() {
    return {
      id: "item1",
      title: "Prod DB",
      fields: [{ id: "f1", title: "password", fieldType: "CONCEALED" }],
    };
  }
  async resolveReference(): Promise<string> {
    return "resolved-secret";
  }
  async resolveCredential(row: Parameters<OnePasswordService["resolveCredential"]>[0]) {
    return row;
  }
}

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

describe("GET/PUT /api/onepassword/settings", () => {
  it("defaults allowPersonal to true on a fresh org", async () => {
    api = await bootTestApi();
    api.providers.onePassword = new FakeOnePasswordService();

    const res = await fetch(`${api.baseUrl}/api/onepassword/settings`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as OnePasswordSettingsResponse;
    expect(body).toMatchObject({ allowPersonal: true, orgTokenConnected: false, personalTokenConnected: false });
  });

  it("member GET is ok; member PUT 403s", async () => {
    api = await bootTestApi();
    api.providers.onePassword = new FakeOnePasswordService();

    const getRes = await fetch(`${api.baseUrl}/api/onepassword/settings`, { headers: MEMBER_HEADERS });
    expect(getRes.status).toBe(200);

    const putRes = await fetch(`${api.baseUrl}/api/onepassword/settings`, {
      method: "PUT",
      headers: MEMBER_HEADERS,
      body: JSON.stringify({ allowPersonal: false }),
    });
    expect(putRes.status).toBe(403);
    expect(await putRes.json()).toEqual({ error: "org admin required" });
  });

  it("org_members admin with users.role=member can PUT settings", async () => {
    api = await bootTestApi();
    api.providers.onePassword = new FakeOnePasswordService();
    await api.providers.db.update(users).set({ role: "member" }).where(eq(users.id, "test-admin"));

    const putRes = await fetch(`${api.baseUrl}/api/onepassword/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "x-valet-test-user-id": "test-admin" },
      body: JSON.stringify({ allowPersonal: false }),
    });
    expect(putRes.status).toBe(200);
    expect((await putRes.json() as OnePasswordSettingsResponse).allowPersonal).toBe(false);
  });

  it("global operator who is not an org admin cannot PUT settings", async () => {
    api = await bootTestApi();
    api.providers.onePassword = new FakeOnePasswordService();
    await api.providers.db.update(users).set({ role: "admin" }).where(eq(users.id, "test-member"));
    await api.providers.db.update(orgMembers).set({ role: "member" }).where(eq(orgMembers.userId, "test-member"));

    const putRes = await fetch(`${api.baseUrl}/api/onepassword/settings`, {
      method: "PUT",
      headers: MEMBER_HEADERS,
      body: JSON.stringify({ allowPersonal: false }),
    });
    expect(putRes.status).toBe(403);
    expect(await putRes.json()).toEqual({ error: "org admin required" });
  });

  it("admin PUT flips the toggle and GET reflects it", async () => {
    api = await bootTestApi();
    api.providers.onePassword = new FakeOnePasswordService();

    const putRes = await fetch(`${api.baseUrl}/api/onepassword/settings`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ allowPersonal: false }),
    });
    expect(putRes.status).toBe(200);

    const getRes = await fetch(`${api.baseUrl}/api/onepassword/settings`);
    const body = (await getRes.json()) as OnePasswordSettingsResponse;
    expect(body.allowPersonal).toBe(false);
  });
});

describe("GET /api/onepassword/vaults", () => {
  it("scope=org as member returns vaults from the fake service (org token is shared org-wide)", async () => {
    api = await bootTestApi();
    const fake = new FakeOnePasswordService();
    fake.orgToken = true;
    api.providers.onePassword = fake;

    const res = await fetch(`${api.baseUrl}/api/onepassword/vaults?scope=org`, { headers: MEMBER_HEADERS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListOpVaultsResponse;
    expect(body.vaults).toEqual([{ id: "vault1", title: "Engineering" }]);
    expect(fake.vaultsCalls).toEqual(["org"]);
  });

  it("scope=org as member with no org token connected 400s with a hint", async () => {
    api = await bootTestApi();
    api.providers.onePassword = new FakeOnePasswordService();

    const res = await fetch(`${api.baseUrl}/api/onepassword/vaults?scope=org`, { headers: MEMBER_HEADERS });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("organization 1Password service account token");
  });

  it("scope=org as admin returns vaults from the fake service", async () => {
    api = await bootTestApi();
    const fake = new FakeOnePasswordService();
    fake.orgToken = true;
    api.providers.onePassword = fake;

    const res = await fetch(`${api.baseUrl}/api/onepassword/vaults?scope=org`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListOpVaultsResponse;
    expect(body.vaults).toEqual([{ id: "vault1", title: "Engineering" }]);
    expect(fake.vaultsCalls).toEqual(["org"]);
  });

  it("scope=personal with the toggle off 403s", async () => {
    api = await bootTestApi();
    const fake = new FakeOnePasswordService();
    fake.personalToken = true;
    api.providers.onePassword = fake;

    await fetch(`${api.baseUrl}/api/onepassword/settings`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ allowPersonal: false }),
    });

    const res = await fetch(`${api.baseUrl}/api/onepassword/vaults?scope=personal`);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "personal 1Password tokens are disabled by your organization" });
  });

  it("scope=personal with no personal token connected 400s with a hint", async () => {
    api = await bootTestApi();
    api.providers.onePassword = new FakeOnePasswordService();

    const res = await fetch(`${api.baseUrl}/api/onepassword/vaults?scope=personal`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("personal 1Password service account token");
  });

  it("raw SDK rejection maps to 502 without leaking the SDK text", async () => {
    api = await bootTestApi();
    const fake = new FakeOnePasswordService();
    fake.orgToken = true;
    fake.listVaults = async () => {
      throw new Error("vault boom secret=xyz");
    };
    api.providers.onePassword = fake;

    const res = await fetch(`${api.baseUrl}/api/onepassword/vaults?scope=org`);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body).toEqual({ error: "1Password request failed" });
    expect(JSON.stringify(body)).not.toContain("vault boom");
    expect(JSON.stringify(body)).not.toContain("secret=xyz");
  });

  it("401s without auth configured", async () => {
    api = await bootTestApi();
    api.providers.onePassword = new FakeOnePasswordService();
    const prev = process.env.VALET_LOCAL_AUTH;
    process.env.VALET_LOCAL_AUTH = "0";
    try {
      const res = await fetch(`${api.baseUrl}/api/onepassword/vaults`);
      expect(res.status).toBe(401);
    } finally {
      process.env.VALET_LOCAL_AUTH = prev;
    }
  });
});

describe("GET /api/onepassword/vaults/:vaultId/items", () => {
  it("scope=org as admin returns items from the fake service", async () => {
    api = await bootTestApi();
    const fake = new FakeOnePasswordService();
    fake.orgToken = true;
    api.providers.onePassword = fake;

    const res = await fetch(`${api.baseUrl}/api/onepassword/vaults/vault1/items?scope=org`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListOpItemsResponse;
    expect(body.items).toEqual([{ id: "item1", title: "Prod DB", vaultId: "vault1" }]);
  });
});

describe("GET /api/onepassword/vaults/:vaultId/items/:itemId", () => {
  it("returns field metadata without any secret value", async () => {
    api = await bootTestApi();
    const fake = new FakeOnePasswordService();
    fake.orgToken = true;
    api.providers.onePassword = fake;

    const res = await fetch(`${api.baseUrl}/api/onepassword/vaults/vault1/items/item1?scope=org`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as OpItemDetailResponse;
    expect(body).toEqual({
      id: "item1",
      title: "Prod DB",
      fields: [{ id: "f1", title: "password", fieldType: "CONCEALED" }],
    });
    expect(JSON.stringify(body)).not.toContain('"value"');
  });

});
// A vault can hold hundreds of items. The SDK has no page parameter, so the
// route slices; what that bounds is the response and the DOM built from it.
describe("GET /api/onepassword/vaults/:vaultId/items — pagination", () => {
  /** Returns the booted api so the cases below need no non-null assertions. */
  async function bootWithItems(count: number): Promise<TestApi> {
    const booted = await bootTestApi();
    api = booted;
    const fake = new FakeOnePasswordService();
    fake.orgToken = true;
    fake.itemCount = count;
    booted.providers.onePassword = fake;
    return booted;
  }

  it("caps the page and hands back a cursor that continues it", async () => {
    const api = await bootWithItems(250);

    const first = await fetch(`${api.baseUrl}/api/onepassword/vaults/vault1/items?scope=org&limit=100`);
    expect(first.status).toBe(200);
    const page1 = (await first.json()) as { items: { id: string }[]; nextCursor?: string };
    expect(page1.items).toHaveLength(100);
    expect(page1.nextCursor).toBeTruthy();

    const second = await fetch(
      `${api.baseUrl}/api/onepassword/vaults/vault1/items?scope=org&limit=100&cursor=${encodeURIComponent(page1.nextCursor!)}`,
    );
    const page2 = (await second.json()) as { items: { id: string }[]; nextCursor?: string };
    expect(page2.items).toHaveLength(100);
    // The pages are disjoint and continue where the first one stopped.
    expect(page2.items[0].id).toBe("item101");

    const third = await fetch(
      `${api.baseUrl}/api/onepassword/vaults/vault1/items?scope=org&limit=100&cursor=${encodeURIComponent(page2.nextCursor!)}`,
    );
    const page3 = (await third.json()) as { items: unknown[]; nextCursor?: string };
    expect(page3.items).toHaveLength(50);
    // No cursor on the last page, so a client knows to stop.
    expect(page3.nextCursor).toBeUndefined();
  });

  it("400s a corrupted cursor rather than silently restarting at page one", async () => {
    const api = await bootWithItems(10);
    const res = await fetch(`${api.baseUrl}/api/onepassword/vaults/vault1/items?scope=org&cursor=not-a-cursor`);
    expect(res.status).toBe(400);
  });

  it("400s a non-numeric limit", async () => {
    const api = await bootWithItems(10);
    const res = await fetch(`${api.baseUrl}/api/onepassword/vaults/vault1/items?scope=org&limit=abc`);
    expect(res.status).toBe(400);
  });
});

// Connecting a token and then hand-typing a service name per credential is
// work the registry plus the vault listing can do. These pin that the match
// is narrow and that a partial scan says so.
describe("GET /api/onepassword/suggestions", () => {
  it("suggests an unconnected service whose name an item title carries", async () => {
    // The registry is what makes a suggestion possible: it names the
    // services that declare a credential.
    api = await bootTestApi({ plugins: [linearPlugin] });
    const fake = new FakeOnePasswordService();
    fake.orgToken = true;
    fake.itemTitles = ["Linear API Key", "Unrelated note", "Linearity Pro"];
    api.providers.onePassword = fake;

    const res = await fetch(`${api.baseUrl}/api/onepassword/suggestions?scope=org`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      suggestions: { service: string; itemTitle: string }[];
      unreadableVaults: string[];
    };
    const linear = body.suggestions.filter((s) => s.service === "linear");
    expect(linear).toHaveLength(1);
    expect(linear[0].itemTitle).toBe("Linear API Key");
    // "Linearity Pro" contains "linear" as a prefix, not as a word.
    expect(body.suggestions.some((s) => s.itemTitle === "Linearity Pro")).toBe(false);
    expect(body.unreadableVaults).toEqual([]);
  });

  it("names a vault it could not read instead of dropping it", async () => {
    // The registry is what makes a suggestion possible: it names the
    // services that declare a credential.
    api = await bootTestApi({ plugins: [linearPlugin] });
    const fake = new FakeOnePasswordService();
    fake.orgToken = true;
    fake.itemTitles = ["Linear API Key"];
    fake.unreadableVaultIds = new Set(["vault1"]);
    api.providers.onePassword = fake;

    const res = await fetch(`${api.baseUrl}/api/onepassword/suggestions?scope=org`);
    const body = (await res.json()) as { suggestions: unknown[]; unreadableVaults: string[] };
    expect(body.unreadableVaults).toEqual(["Engineering"]);
    expect(body.suggestions).toEqual([]);
  });
});
