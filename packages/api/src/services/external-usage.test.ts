import { expect, it, vi } from "vitest";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { externalUsageRetention } from "./external-usage.js";

it("indexes retained text only and backs off retention failures", async () => {
  const { appDb: db, pgdb } = await freshTestPgDb();
  const indexes = await pgdb.query("SELECT indexdef FROM pg_indexes WHERE indexname = 'external_calls_intent_retention'");
  expect(indexes.rows[0]?.indexdef).toMatch(/created_at.*WHERE \(intent IS NOT NULL\)/);
  const execute = vi.spyOn(db, "execute").mockRejectedValue(new Error("database unavailable"));
  try {
    const retain = externalUsageRetention(db);
    await expect(retain()).rejects.toThrow("database unavailable");
    await retain();
    expect(execute).toHaveBeenCalledOnce();
  } finally { execute.mockRestore(); }
});
