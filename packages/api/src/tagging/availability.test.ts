import { afterEach, expect, it, vi } from "vitest";
import * as resolution from "../services/model-resolution.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { PgCredentialStore } from "../plugins/credential-store.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { configureTaggingAvailability, taggingAvailable } from "./availability.js";
afterEach(() => vi.restoreAllMocks());
it("caches model availability per organization, including missing-model responses", async () => {
  const { appDb, pgdb } = await freshTestPgDb();
  const resolve = vi.spyOn(resolution, "resolveModelSpec").mockResolvedValue(null);
  configureTaggingAvailability(appDb, new PgCredentialStore(pgdb, deriveSecretKey("fixture")));
  expect(await taggingAvailable(appDb, "one")).toBe(false);
  expect(await taggingAvailable(appDb, "one")).toBe(false);
  expect(resolve).toHaveBeenCalledTimes(1);
  expect(await taggingAvailable(appDb, "two")).toBe(false);
  expect(resolve).toHaveBeenCalledTimes(2);
});
