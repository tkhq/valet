import { describe, expect, it } from "vitest";
import { validateValetPlugin } from "@valet/engine";
import plugin from "./plugin.js";

describe("docs analytics plugin manifest", () => {
  it("passes structural validation", () => {
    expect(validateValetPlugin(plugin)).toEqual({ ok: true, plugin });
  });

  it("declares an organization-owned API key for the report action", () => {
    expect(plugin.credentials).toContainEqual({
      service: "docs_analytics",
      type: "api_key",
      configKeys: ["accessToken"],
      connectLabel: "Docs Analytics report token",
      requires: { orgCredential: true },
    });
    expect(plugin.actions?.[0]?.actions.map((action) => action.id)).toContain("docs_analytics.report");
  });
});
