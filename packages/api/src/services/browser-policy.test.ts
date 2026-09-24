import { beforeEach, describe, expect, it } from "vitest";
import type { BrowserIdentity, BrowserPolicyRequest } from "@valet/shared";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { pluginStore } from "./plugin-store.js";
import { BrowserPolicy } from "./browser-policy.js";

const identity: BrowserIdentity = {
  protocolVersion: "1.0",
  sessionId: "s",
  threadId: "t",
  actorId: "u",
  ownerId: "u",
};
const request: BrowserPolicyRequest = {
  ...identity,
  cellId: "c",
  invocationId: "i",
  runtimeId: "r",
  operationId: "op",
  hash: "hash",
  method: "click",
  operationClass: "mutation",
  origin: "https://example.com",
  target: "Submit",
  policyVersion: "default",
  expiresAt: Date.now() + 60_000,
};

describe("durable browser policy", () => {
  let service: BrowserPolicy;
  let makeService: () => BrowserPolicy;
  let member: boolean;
  let team: boolean;
  beforeEach(async () => {
    const { appDb } = await freshTestPgDb();
    member = true;
    team = false;
    makeService = () =>
      new BrowserPolicy({
        store: pluginStore(appDb, "browser"),
        owner: async () => ({ type: team ? "team" : "user", id: "u" }),
        isMember: async () => member,
        isAdmin: async (_owner, actor) => actor === "u",
        blobs: {
          put: async () => {},
          get: async () => null,
          delete: async () => {},
        },
      });
    service = makeService();
  });
  it("allows the owner to observe, but asks before a mutation", async () => {
    await expect(service.authorize(identity)).resolves.toEqual({
      policyVersion: "default",
    });
    await expect(service.decide(request)).resolves.toMatchObject({
      decision: "ask",
    });
    await expect(
      service.decide({ ...request, operationClass: "observation" }),
    ).resolves.toMatchObject({ decision: "allow" });
    await expect(
      service.authorize({ ...identity, actorId: "other" }),
    ).rejects.toThrow("access");
  });
  it("denies team use until an admin declares the transcript audience", async () => {
    team = true;
    await expect(service.authorize(identity)).rejects.toThrow("team");
    await service.updateSettings(identity, {
      enabled: true,
      audience: "team",
      grants: [],
    });
    await expect(
      service.authorize({ ...identity, actorId: "member" }),
    ).resolves.toBeDefined();
    member = false;
    await expect(
      service.authorize({ ...identity, actorId: "member" }),
    ).rejects.toThrow("access");
  });
  it("retains grants across service reconstruction and revokes old decisions", async () => {
    const settings = await service.updateSettings(identity, {
      enabled: true,
      audience: "owner",
      grants: [
        {
          id: "g",
          origin: "https://example.com",
          operations: ["mutation"],
          expiresAt: Date.now() + 60_000,
        },
      ],
    });
    const current = { ...request, policyVersion: settings.policyVersion };
    await expect(makeService().decide(current)).resolves.toMatchObject({
      decision: "allow",
    });
    await service.updateSettings(identity, {
      enabled: true,
      audience: "owner",
      grants: [],
    });
    await expect(service.approve(current, "u")).rejects.toThrow("changed");
  });
  it("rejects expired decisions and unauthorized approvers", async () => {
    await expect(
      service.approve({ ...request, expiresAt: 1 }, "u"),
    ).rejects.toThrow("expired");
    await expect(service.approve(request, "other")).rejects.toThrow("access");
  });
  it("stores only sanitized receipts, without page content or credentials", async () => {
    await service.audit(identity, {
      operationId: "op",
      cellId: "c",
      method: "click",
      hash: "hash",
      status: "completed",
      result: { password: "secret" },
    });
    const records = await service.auditRecords(identity);
    expect(JSON.stringify(records)).not.toContain("secret");
    expect(records[0]).toMatchObject({
      operationId: "op",
      actorId: "u",
      status: "completed",
    });
  });
});
