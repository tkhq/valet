import { expect, it, vi } from "vitest";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { externalUsageRetention, recordExternalCall, saveMcpClientInfo } from "./external-usage.js";

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

it.each(["hosted", "mcp", "cli"] as const)("persists %s usage with NUL and lone surrogates without dropping the fact", async surface => {
  const { appDb: db, pgdb } = await freshTestPgDb();
  const call = { id: "unicode-usage", orgId: "o1", userId: "u1", surface,
    name: "action", ownerType: "user" as const, ownerId: "u1", outcome: "ok" as const,
    durationMs: 1, createdAt: 1, intent: "Check\u0000 the \ud800requested\udfff action 😀", clientName: "Client\ud800", clientVersion: "1\u0000" };
  await recordExternalCall(db, call);
  const result = await pgdb.query("SELECT intent, client_name, client_version FROM external_calls WHERE id = $1", [call.id]);
  expect(result.rows).toEqual([{ intent: "Check the requested action 😀", client_name: "Client", client_version: "1" }]);
});

it("sanitizes truncated MCP metadata without splitting astral characters into invalid text", async () => {
  const { appDb: db, pgdb } = await freshTestPgDb();
  await saveMcpClientInfo(db, { orgId: "o1", userId: "u1", clientId: "c1" },
    { name: "n".repeat(199) + "😀", version: "v\u0000\ud800😀" });
  const result = await pgdb.query("SELECT name, version FROM mcp_client_info WHERE client_id = 'c1'");
  expect(result.rows).toEqual([{ name: "n".repeat(199), version: "v😀" }]);
});
