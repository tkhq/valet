/**
 * Every JSON example in the shipped `workflows` skill must pass the save
 * validator.
 *
 * Agents copy these examples into the definitions they save. An example
 * that the validator rejects teaches every agent the same wrong shape: a
 * stop step with `outcome: "completed"` (a run outcome, not a stop outcome)
 * was one. This test reads the skill text that the real plugin ships and
 * moves that drift to CI.
 */
import { describe, expect, it } from "vitest";
import type { ActionPlugin, ValetPlugin } from "@valet/engine";
import { bundledPlugins } from "../plugins/registry.gen.js";
import { validateDefinitionInput } from "./service.js";
import { buildValidateEnvironment } from "./validation-env.js";

const actionPluginByService = new Map<string, { plugin: ValetPlugin; actionPlugin: ActionPlugin }>();
for (const plugin of bundledPlugins) {
  for (const actionPlugin of plugin.actions ?? []) {
    actionPluginByService.set(actionPlugin.service, { plugin, actionPlugin });
  }
}
const env = buildValidateEnvironment(actionPluginByService);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function skillText(): string {
  const skill = bundledPlugins
    .find((plugin) => plugin.name === "workflows")
    ?.skills?.find((entry) => entry.name === "workflows");
  if (!skill) throw new Error('the bundled "workflows" plugin ships no "workflows" skill');
  return skill.content;
}

/** The body of every ```json fenced block, in order. */
function jsonBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== "```json") continue;
    const end = lines.findIndex((text, j) => j > i && text.trim() === "```");
    if (end === -1) throw new Error(`the json block after "${lines[i - 1] ?? ""}" has no closing fence`);
    blocks.push(lines.slice(i + 1, end).join("\n"));
    i = end;
  }
  return blocks;
}

/** A short name for one block in a test title: its first line that is more than a bracket. */
function headline(block: string): string {
  const first = block.split("\n").map((text) => text.trim()).find((text) => text.length > 1) ?? "";
  return first.length > 60 ? `${first.slice(0, 60)}...` : first;
}

/**
 * The definition one example stands for. A whole definition stands for
 * itself. A single node goes after a bare trigger, so the validator checks
 * its fields the same way a save does. An edge list has no nodes to check.
 */
function definitionOf(example: unknown): unknown {
  if (Array.isArray(example)) return undefined;
  if (!isRecord(example)) throw new Error("an example must be a JSON object or array");
  if ("nodes" in example || "version" in example) return example;
  if (example.type === "trigger") return { version: "dag/v1", nodes: [example], edges: [] };
  return {
    version: "dag/v1",
    nodes: [{ id: "example_start", type: "trigger" }, example],
    edges: [{ from: "example_start", to: example.id }],
  };
}

const blocks = jsonBlocks(skillText());

describe("workflows skill examples", () => {
  it("finds the definition examples", () => {
    // A broken extractor must not pass by finding nothing to check.
    const definitions = blocks.filter((block) => /"version":\s*"dag\/v1"/.test(block));
    expect(definitions.length).toBeGreaterThanOrEqual(2);
  });

  it.each(blocks.map((block, index) => [index + 1, headline(block), block] as const))(
    "json block %i (%s) passes the save validator",
    (_index, _headline, block) => {
      // A json fence that does not parse would silently skip the check below.
      const example: unknown = JSON.parse(block);
      const definition = definitionOf(example);
      if (definition === undefined) return;
      const validation = validateDefinitionInput(definition, env);
      expect(validation.ok ? [] : validation.errors).toEqual([]);
    },
  );
});
