/**
 * Approved-models allowlist: get/set the org's model approval list, validate
 * model selectability, and check tier tokens (which always pass).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { orgs } from "../schema/index.js";
import {
  getApprovedModels,
  setApprovedModels,
  isApproved,
  assertModelSelectable,
} from "./approved-models.js";

const orgId = "org-approved-models";

describe("approved-models", () => {
  let db: AppDb;

  beforeEach(async () => {
    const { appDb } = await freshTestPgDb();
    db = appDb;
    await db.insert(orgs).values({ id: orgId, name: "Org", createdAt: Date.now() });
  });

  afterEach(() => vi.unstubAllEnvs());

  describe("getApprovedModels", () => {
    it("null list approves everything", async () => {
      expect(await assertModelSelectable(db, orgId, false, "anthropic/claude-opus-4-7")).toBeNull();
    });
  });

  describe("tier tokens always pass", () => {
    it("tier tokens always pass", async () => {
      await setApprovedModels(db, orgId, ["anthropic/claude-haiku-4-5"]);
      expect(await assertModelSelectable(db, orgId, false, "l")).toBeNull();
      expect(await assertModelSelectable(db, orgId, false, "XL")).toBeNull(); // case-insensitive like resolveModelSpec
    });
  });

  describe("admins always pass", () => {
    it("admins always pass", async () => {
      await setApprovedModels(db, orgId, ["anthropic/claude-haiku-4-5"]);
      expect(await assertModelSelectable(db, orgId, true, "openai/gpt-4.1")).toBeNull();
    });
  });

  describe("members are held to the list", () => {
    it("members are held to the list", async () => {
      await setApprovedModels(db, orgId, ["anthropic/claude-haiku-4-5"]);
      expect(await assertModelSelectable(db, orgId, false, "openai/gpt-4.1")).toMatch(/approved list/);
      expect(await assertModelSelectable(db, orgId, false, "anthropic/claude-haiku-4-5")).toBeNull();
    });
  });

  describe("round-trips and clears", () => {
    it("round-trips and clears", async () => {
      await setApprovedModels(db, orgId, ["a/b"]);
      expect(await getApprovedModels(db, orgId)).toEqual(["a/b"]);
      await setApprovedModels(db, orgId, null);
      expect(await getApprovedModels(db, orgId)).toBeNull();
    });
  });
});
