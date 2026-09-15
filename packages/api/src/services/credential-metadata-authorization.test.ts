import { describe, expect, it, vi } from "vitest";
import type { CredentialStore } from "@valet/engine";
import { ResourceAuthorizationError, type ResourceAuthorizationPort } from "../authorization/resource-authorization.js";
import { CredentialMetadataAuthorization } from "./credential-metadata-authorization.js";

const context = { organizationId: "org-1", actorUserId: "user-1", principal: { type: "user" as const, id: "user-1" }, deliveryId: "delivery-1" };
const owner = { type: "user" as const, id: "user-1" };
const db = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) };

describe("credential metadata authorization boundary", () => {
  it("does not read credential values when policy denies", async () => {
    const get = vi.fn<CredentialStore["get"]>();
    const store = { get, list: vi.fn(), save: vi.fn(), delete: vi.fn() } as CredentialStore;
    const port: ResourceAuthorizationPort = { authorize: async () => { throw new ResourceAuthorizationError("deny"); } };
    const service = new CredentialMetadataAuthorization(db as never, store, port, context);
    await expect(service.get(owner, "github")).rejects.toThrow(ResourceAuthorizationError);
    expect(get).not.toHaveBeenCalled();
  });

  it("does not pass secret values to policy", async () => {
    const canary = "secret-canary-value";
    const authorize = vi.fn<ResourceAuthorizationPort["authorize"]>().mockResolvedValue({ schemaVersion: 1, readOnly: false, redactions: [] });
    const get = vi.fn<CredentialStore["get"]>().mockResolvedValue({ type: "api_key", apiKey: canary });
    const store = { get, list: vi.fn(), save: vi.fn(), delete: vi.fn() } as CredentialStore;
    const service = new CredentialMetadataAuthorization(db as never, store, { authorize }, context);
    await expect(service.get(owner, "github")).resolves.toMatchObject({ apiKey: canary });
    expect(JSON.stringify(authorize.mock.calls)).not.toContain(canary);
  });
});
