/**
 * A credential is stored under `decl.service ?? plugin.name` (the connect
 * flow's key) and read back under `actionPlugin.credentialService ??
 * actionPlugin.service` (the invoker's key). When the two disagree, the
 * connect flow works, the token persists — and every tool call fails to
 * find it, while the connect dialog degrades to the "cannot confirm which
 * tools this connection unlocks" arm. google-calendar and google-workspace
 * both shipped this way (plugin name "google-workspace" vs action service
 * "google_workspace"); this suite makes the mismatch a test failure
 * instead of a customer-facing dead integration.
 */
import { describe, it, expect } from "vitest";
import { bundledPlugins } from "./registry.gen.js";

describe("credential/action service alignment", () => {
  const withBoth = bundledPlugins.filter(
    (plugin) => (plugin.credentials ?? []).length > 0 && (plugin.actions ?? []).length > 0,
  );

  it("covers the plugins that declare both credentials and actions", () => {
    // Guard against the suite silently going vacuous if the registry shape
    // changes — today this set includes github, gmail, slack and the two
    // google plugins.
    expect(withBoth.length).toBeGreaterThanOrEqual(5);
  });

  for (const plugin of withBoth) {
    it(`${plugin.name}: every stored credential service is read by an action plugin`, () => {
      const readKeys = new Set(
        (plugin.actions ?? []).map((actionPlugin) => actionPlugin.credentialService ?? actionPlugin.service),
      );
      for (const decl of plugin.credentials ?? []) {
        const storedAs = decl.service ?? plugin.name;
        expect(
          readKeys,
          `credential stored as "${storedAs}" but the plugin's actions read ${JSON.stringify([...readKeys])} — set decl.service to the action service`,
        ).toContain(storedAs);
      }
    });
  }
});
