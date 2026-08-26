/**
 * `/api/onepassword` — picker-backend routes + org/personal settings
 * (1Password credential provider plan, Task 3). Providers.onePassword is
 * swapped for a `FakeOnePasswordService` post-boot (same pattern
 * `prebuilds.test.ts` uses for `imageBuilder`) so these tests never touch the
 * real `@1password/sdk`.
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
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
  async listItems() {
    return [{ id: "item1", title: "Prod DB", vaultId: "vault1" }];
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
