/**
 * `/api/onepassword` — picker-backend routes and the settings read
 * (1Password credential provider plan, Task 3). Providers.onePassword is
 * swapped for a `FakeOnePasswordService` post-boot (same pattern
 * `prebuilds.test.ts` uses for `imageBuilder`) so these tests never touch the
 * real `@1password/sdk`.
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { OnePasswordAuthError, type OnePasswordCtx, type OnePasswordScope, type OnePasswordService } from "../services/onepassword.js";
import type { ListOpVaultsResponse } from "../wire/types.js";

const HEADERS = { "Content-Type": "application/json" };
const MEMBER_HEADERS = { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" };

class FakeOnePasswordService implements OnePasswordService {
  findCandidates = async (): Promise<never[]> => [];
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
  async resolveReference(): Promise<string> {
    return "resolved-secret";
  }
  async findCredentialForService(): Promise<string | null> {
    return null;
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

describe("GET /api/onepassword/settings", () => {
  it("answers any org member with the two connection flags and nothing else", async () => {
    api = await bootTestApi();
    api.providers.onePassword = new FakeOnePasswordService();

    const res = await fetch(`${api.baseUrl}/api/onepassword/settings`, { headers: MEMBER_HEADERS });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ orgTokenConnected: false, personalTokenConnected: false });
  });

  // The org-wide switch that used to gate personal tokens is gone: a member's
  // own service-account token needs no organization permission (TKAI-487).
  it("no longer exposes a settings write", async () => {
    api = await bootTestApi();
    api.providers.onePassword = new FakeOnePasswordService();

    const res = await fetch(`${api.baseUrl}/api/onepassword/settings`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ allowPersonal: false }),
    });
    expect(res.status).toBe(404);
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
