import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dashboard = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../../deploy/chart/valet/dashboards/valet.json", import.meta.url)),
    "utf8",
  ),
);

describe("valet dashboard Images row", () => {
  it("has the Images row with the four PR 3 metrics and unique panel ids", () => {
    const panels = dashboard.panels as Array<{
      id: number;
      type: string;
      title: string;
      targets?: Array<{ expr: string }>;
    }>;
    const row = panels.find((p) => p.type === "row" && p.title === "Images");
    expect(row).toBeDefined();
    const exprs = panels.flatMap((p) => (p.targets ?? []).map((t) => t.expr)).join("\n");
    for (const metric of [
      "valet_prebuild_sources",
      "valet_prebuild_sources_bound_unhealthy",
      "valet_prebuild_scheduler_last_pass_age_seconds",
      "valet_sandbox_image_fallback_total",
      "valet_sandbox_startup_failed_total",
    ]) {
      expect(exprs).toContain(metric);
    }
    const ids = panels.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
