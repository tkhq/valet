import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ValetPlugin } from "@valet/engine";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { eventSubscriptions } from "../schema/index.js";
import { reportUnloadedPluginLines, unloadedPluginLines } from "./plugin-line-metrics.js";

const loaded: ValetPlugin = {
  name: "pr-review",
  version: "0.0.1",
  eventHandlers: [{ id: "review-pull-request", description: "Review.", events: ["github.pull_request.opened"], handle: async () => {} }],
};

describe("unloaded plugin lines", () => {
  it("lists enabled plugin lines whose handler is not loaded, and nothing else", async () => {
    const { appDb: db } = await freshTestPgDb();
    const now = Date.now();
    const row = (id: string, target: Record<string, unknown>, enabled = true) => ({
      id, orgId: "org-1", ownerType: "user" as const, ownerId: "user-1", name: `line ${id}`, eventKeys: ["github.pull_request.opened"],
      filters: [], target, enabled, createdBy: "user-1", createdAt: now, updatedAt: now,
    });
    await db.insert(eventSubscriptions).values([
      row("ok", { kind: "plugin", plugin: "pr-review", handler: "review-pull-request" }),
      row("gone-plugin", { kind: "plugin", plugin: "dropped", handler: "review-pull-request" }),
      row("gone-handler", { kind: "plugin", plugin: "pr-review", handler: "renamed" }),
      row("off", { kind: "plugin", plugin: "dropped", handler: "x" }, false),
      row("assistant", { kind: "assistant" }),
    ]);

    const lines = await unloadedPluginLines(db, [loaded]);
    expect(lines.map((l) => l.id).sort()).toEqual(["gone-handler", "gone-plugin"]);
    expect(await reportUnloadedPluginLines(db, [loaded])).toHaveLength(2);
    expect(await unloadedPluginLines(db, [])).toHaveLength(3);
  });

  it("has an alert on the gauge", () => {
    const alerts = readFileSync(fileURLToPath(new URL("../../../../deploy/chart/valet/alerts/events.yaml", import.meta.url)), "utf8");
    expect(alerts).toContain("max(valet_plugin_lines_unloaded_handler)");
  });
});
