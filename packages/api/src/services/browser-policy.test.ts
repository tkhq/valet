import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BrowserIdentity,
  BrowserOperationClass,
  BrowserPolicyRequest,
} from "@valet/shared";
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
  method: "locator.click",
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
  afterEach(() => vi.restoreAllMocks());

  it("restricts personal browser access to its owner", async () => {
    await expect(service.authorize(identity)).resolves.toEqual({
      policyVersion: "default",
    });
    await expect(
      service.decide({ ...request, actorId: "other" }),
    ).rejects.toThrow("access");
  });

  it.each<{ operationClass: BrowserOperationClass; method: string }>([
    { operationClass: "observation", method: "tab.getAXState" },
    { operationClass: "navigation", method: "tabs.new" },
    { operationClass: "navigation", method: "tab.goto" },
    { operationClass: "navigation", method: "tab.reload" },
    { operationClass: "navigation", method: "tab.back" },
    { operationClass: "navigation", method: "tab.forward" },
    { operationClass: "mutation", method: "locator.click" },
    { operationClass: "mutation", method: "locator.fill" },
    { operationClass: "mutation", method: "tab.scroll" },
    { operationClass: "mutation", method: "tab.markDeliverable" },
    { operationClass: "history", method: "browser.history" },
    { operationClass: "diagnostic", method: "tab.logs" },
  ])("allows $method without a separate grant", async (operation) => {
    const current = {
      ...request,
      ...operation,
      origin: "http://localhost:5173",
    };
    await expect(service.decide(current)).resolves.toMatchObject({
      decision: "allow",
    });
    await expect(
      makeService().decide({ ...current, operationId: "next-operation" }),
    ).resolves.toMatchObject({ decision: "allow" });
  });

  it.each<BrowserOperationClass>(["upload", "export", "page_tool"])(
    "asks before %s without a matching grant",
    async (operationClass) => {
      await expect(
        service.decide({ ...request, operationClass }),
      ).resolves.toMatchObject({ decision: "ask" });
    },
  );

  it.each<BrowserOperationClass>(["navigation", "mutation"])(
    "denies expired or revoked %s operations before applying defaults",
    async (operationClass) => {
      await expect(
        service.decide({ ...request, operationClass, expiresAt: 1 }),
      ).resolves.toMatchObject({ decision: "deny" });
      await service.updateSettings(identity, {
        enabled: true,
        audience: "owner",
        grants: [],
      });
      await expect(
        service.decide({ ...request, operationClass }),
      ).resolves.toMatchObject({ decision: "deny" });
    },
  );

  it("does not let routine actions bypass disabled access or changed ownership", async () => {
    await expect(
      service.decide({ ...request, ownerId: "old-owner" }),
    ).rejects.toThrow("ownership changed");
    const settings = await service.updateSettings(identity, {
      enabled: false,
      audience: "owner",
      grants: [],
    });
    await expect(
      service.decide({ ...request, policyVersion: settings.policyVersion }),
    ).rejects.toThrow("disabled");
  });
  it("denies team use until an admin declares the transcript audience", async () => {
    team = true;
    await expect(service.authorize(identity)).rejects.toThrow("team");
    const settings = await service.updateSettings(identity, {
      enabled: true,
      audience: "team",
      grants: [],
    });
    await expect(
      service.decide({
        ...request,
        actorId: "member",
        policyVersion: settings.policyVersion,
      }),
    ).resolves.toMatchObject({ decision: "allow" });
    member = false;
    await expect(
      service.decide({
        ...request,
        actorId: "member",
        policyVersion: settings.policyVersion,
      }),
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
          operations: ["upload"],
          expiresAt: Date.now() + 60_000,
        },
      ],
    });
    const current: BrowserPolicyRequest = {
      ...request,
      operationClass: "upload",
      policyVersion: settings.policyVersion,
    };
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

  it("restricts sensitive grants to their origin, operation class, and expiry", async () => {
    const expiresAt = Date.now() + 30_000;
    const settings = await service.updateSettings(identity, {
      enabled: true,
      audience: "owner",
      grants: [
        { id: "g", origin: request.origin, operations: ["upload"], expiresAt },
      ],
    });
    const current: BrowserPolicyRequest = {
      ...request,
      operationClass: "upload",
      policyVersion: settings.policyVersion,
      expiresAt: expiresAt + 60_000,
    };
    await expect(service.decide(current)).resolves.toMatchObject({
      decision: "allow",
    });
    await expect(
      service.decide({ ...current, origin: "https://other.example.com" }),
    ).resolves.toMatchObject({ decision: "ask" });
    await expect(
      service.decide({ ...current, operationClass: "export" }),
    ).resolves.toMatchObject({ decision: "ask" });
    vi.spyOn(Date, "now").mockReturnValue(expiresAt);
    await expect(service.decide(current)).resolves.toMatchObject({
      decision: "ask",
    });
  });

  it("keeps a one-operation approval from becoming a durable sensitive grant", async () => {
    const current: BrowserPolicyRequest = {
      ...request,
      operationClass: "upload",
    };
    await expect(service.approve(current, "u")).resolves.toEqual({
      policyVersion: "default",
    });
    await expect(
      service.decide({ ...current, operationId: "next-upload" }),
    ).resolves.toMatchObject({ decision: "ask" });
    expect((await service.settings(identity.sessionId)).grants).toEqual([]);
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
