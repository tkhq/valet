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
  validateApprovedModelsList,
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

  describe("isApproved normalizes bare vs namespaced Anthropic spellings", () => {
    it("a bare spec is approved under a namespaced list entry", () => {
      expect(isApproved(["anthropic/claude-haiku-4-5"], "claude-haiku-4-5")).toBe(true);
    });

    it("a namespaced spec is approved under a bare list entry", () => {
      expect(isApproved(["claude-haiku-4-5"], "anthropic/claude-haiku-4-5")).toBe(true);
    });

    it("a genuinely unlisted model still fails", () => {
      expect(isApproved(["anthropic/claude-haiku-4-5"], "anthropic/claude-opus-4-7")).toBe(false);
      expect(isApproved(["anthropic/claude-haiku-4-5"], "openai/gpt-4.1")).toBe(false);
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

  describe("validateApprovedModelsList", () => {
    const validIds = new Set(["anthropic/claude-haiku-4-5", "anthropic/claude-opus-4-7"]);

    it("null clears the restriction and is always OK", () => {
      expect(validateApprovedModelsList(null, validIds)).toBeNull();
    });

    it("rejects an empty list with the clear-restriction guidance", () => {
      expect(validateApprovedModelsList([], validIds)).toBe(
        "Approved list cannot be empty. To approve the whole catalog, clear the restriction instead.",
      );
    });

    it("rejects an id not in the catalog, naming the id and GET /api/models", () => {
      const err = validateApprovedModelsList(["anthropic/claude-haiku-4-5", "nope/nope"], validIds);
      expect(err).toMatch(/nope\/nope/);
      expect(err).toMatch(/GET \/api\/models/);
    });

    it("accepts a non-empty list where every id is valid", () => {
      expect(validateApprovedModelsList(["anthropic/claude-haiku-4-5"], validIds)).toBeNull();
    });
  });
});
