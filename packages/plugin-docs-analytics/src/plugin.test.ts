import { describe, expect, it } from "vitest";
import { validateValetPlugin } from "@valet/engine";
import plugin from "./plugin.js";

describe("docs analytics plugin manifest", () => {
  it("passes structural validation", () => {
    expect(validateValetPlugin(plugin)).toEqual({ ok: true, plugin });
  });

  // The report token is a deployment setting, so no user, team, or org
  // connects anything. A credential declaration here would put the plugin
  // on the Integrations page and gate its tool behind a connection.
  it("declares no credential and exposes the report action to every session", () => {
    expect(plugin.credentials).toBeUndefined();
    expect(plugin.actions?.[0]?.requiresCredential).toBeUndefined();
    expect(plugin.actions?.[0]?.actions.map((action) => action.id)).toContain("docs_analytics.report");
  });
});
