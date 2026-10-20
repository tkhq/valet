/**
 * The `approvals` and `event-subscriptions` skills must match the code they
 * describe.
 *
 * Agents repeat what a skill says. A skill that names an approval choice the
 * card does not offer, or shows a subscription the validator refuses, teaches
 * every assistant the same wrong answer. These tests read the skill text that
 * the bundled plugins ship and fail when it drifts from the resolver labels,
 * the filter operators, or the subscription validator.
 */
import { describe, expect, it } from "vitest";
import { bundledPlugins } from "./registry.gen.js";
import { FILTER_OPS, validateSubscription } from "../events/subscription-write.js";
import { GATE_ACTION_LABELS } from "../policies/service.js";

function skillText(pluginName: string, skillName: string): string {
  const skill = bundledPlugins.find((plugin) => plugin.name === pluginName)?.skills?.find((entry) => entry.name === skillName);
  if (!skill) throw new Error(`the bundled "${pluginName}" plugin ships no "${skillName}" skill`);
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

describe("approvals skill", () => {
  const text = skillText("valet", "approvals");

  it.each(Object.values(GATE_ACTION_LABELS))("names the approval choice %s as the card shows it", (label) => {
    expect(text).toContain(`**${label}**`);
  });
});

describe("event-subscriptions skill", () => {
  const text = skillText("workflows", "event-subscriptions");
  const blocks = jsonBlocks(text);

  it("lists every filter operator the validator accepts", () => {
    for (const op of FILTER_OPS) expect(text).toContain(`\`${op}\``);
  });

  it("has an example to check", () => {
    // A broken extractor must not pass by finding nothing.
    expect(blocks.length).toBeGreaterThanOrEqual(1);
  });

  it.each(blocks.map((block, index) => [index + 1, block] as const))(
    "json block %i passes the subscription validator",
    (_index, block) => {
      // The examples use the parameter names of events.propose_subscription,
      // which builds this body for the same validator.
      const example = JSON.parse(block) as {
        name: string; event_keys: string[]; filters?: unknown[]; system_prompt?: string; user_prompt_template?: string;
      };
      const target = {
        kind: "assistant",
        assistant: "user",
        ...(example.system_prompt !== undefined ? { systemPrompt: example.system_prompt } : {}),
        ...(example.user_prompt_template !== undefined ? { userPromptTemplate: example.user_prompt_template } : {}),
      };
      expect(validateSubscription(bundledPlugins, {
        name: example.name, eventKeys: example.event_keys, filters: example.filters ?? [], target,
      })).toBeNull();
    },
  );
});
