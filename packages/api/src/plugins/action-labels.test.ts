import { describe, expect, it } from "vitest";
import { actionLabel, type PluginAction } from "@valet/engine";
import { bundledPlugins } from "./registry.gen.js";

type Schema = { properties?: Record<string, { type?: string; enum?: unknown[]; items?: { type?: string } }> };

const URL_KEYS = new Set(["url", "link", "imageUrl"]);

/** Sample arguments from a parameter schema: a value for every property, optional ones too. */
function sampleArgs(action: PluginAction): Record<string, unknown> {
  const schema = action.parameters as Schema;
  const args: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(schema.properties ?? {})) {
    if (spec.enum?.length) args[key] = spec.enum[0];
    else if (spec.type === "number" || spec.type === "integer") args[key] = 7;
    else if (spec.type === "boolean") args[key] = true;
    else if (spec.type === "array") args[key] = spec.items?.type === "string" ? [`sample ${key}`] : [];
    else if (spec.type === "object") args[key] = {};
    else args[key] = URL_KEYS.has(key) ? "https://user:pw@example.com/a/b?token=secret" : `sample ${key}`;
  }
  return args;
}

/** Arguments that name what a call acted on; a label that has none of them has dropped its target. */
const TARGET_KEYS = ["query", "q", "title", "name", "issueNumber", "pullNumber", "to", "subject", "email", "filename", "fileName", "tagName", "url", "link"];

const registered = bundledPlugins.flatMap((plugin) =>
  (plugin.actions ?? []).flatMap((group) => group.actions.map((action) => ({ service: group.service, action }))),
);

describe("step labels", () => {
  it("finds the bundled actions", () => {
    expect(registered.length).toBeGreaterThan(150);
  });

  it.each(registered.map((entry) => [entry.action.id, entry] as const))("%s has a specific label", (_id, { service, action }) => {
    const label = actionLabel(action, sampleArgs(action), service);
    expect(label, `${action.id} has no step label. Add a label function or a verb the derivation knows.`).toBeTruthy();
    expect(label).toMatch(/^[A-Z][a-z]/);
    expect(label).not.toMatch(/^Used /);
    expect(label).not.toMatch(/secret|user:pw/);
    const schema = action.parameters as Schema;
    const targets = TARGET_KEYS.filter((key) => schema.properties?.[key] && !Array.isArray(sampleArgs(action)[key]));
    if (targets.length) {
      const args = sampleArgs(action);
      const shown = targets.some((key) => {
        const value = String(args[key]);
        return label!.includes(URL_KEYS.has(key) ? "example.com" : value);
      });
      expect(shown, `${action.id} label "${label}" shows none of ${targets.join(", ")}`).toBe(true);
    }
  });

  it("names every service with a dynamic action list", () => {
    const dynamic = bundledPlugins.flatMap((plugin) => plugin.actions ?? []).filter((group) => group.resolveActions);
    expect(dynamic.map((group) => group.service).sort()).toEqual(expect.arrayContaining(["linear", "notion", "sentry"]));
  });
});
