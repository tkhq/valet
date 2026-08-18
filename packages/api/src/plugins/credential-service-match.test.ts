/**
 * Every shipped plugin must store its credential under the name its own
 * actions read.
 *
 * The connect flow writes a credential as `decl.service ?? plugin.name`
 * (`routes/plugins.ts`, `services/integration-oauth.ts`), while an action
 * reads it as `credentialService ?? service` (`plugins/action-invoker.ts`).
 * Those two names are declared in different files and nothing joined them,
 * so a plugin whose action service differed from its plugin name — an
 * underscore against a hyphen was enough — saved a token nothing could read.
 *
 * The failure is silent: connecting the account succeeds, the tools stay
 * unavailable, and `withCredentialRequirement` cannot mark the actions as
 * needing a credential, so the connect screen reports that it cannot say
 * which tools the connection unlocks.
 *
 * This test is the join. It reads the real shipped registry, so a new plugin
 * is covered the day it is added.
 */
import { describe, it, expect } from "vitest";
import { bundledPlugins } from "./registry.gen.js";

describe("plugin credential service names", () => {
  it("match the service their own actions read", () => {
    const mismatches: string[] = [];

    for (const plugin of bundledPlugins) {
      const credentialNames = new Set(
        (plugin.credentials ?? []).map((c) => c.service ?? plugin.name),
      );
      if (credentialNames.size === 0) continue;

      for (const actionPlugin of plugin.actions ?? []) {
        const read = actionPlugin.credentialService ?? actionPlugin.service;
        if (!credentialNames.has(read)) {
          mismatches.push(
            `${plugin.name}: actions read "${read}", credential stores ` +
              `${[...credentialNames].map((n) => `"${n}"`).join(" or ")}`,
          );
        }
      }
    }

    expect(mismatches).toEqual([]);
  });
});
