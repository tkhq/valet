/**
 * Contract tests for the workflow templates every loaded plugin
 * contributes.
 *
 * A template that names a wrong path does not fail when it is saved. It
 * fails on the first RUN, inside a node, in front of whoever installed it.
 * These tests move that failure to CI.
 *
 * The validator catches most of it (unknown node, unknown action, unknown
 * model, a `nodes.x.data` reference). Four things it provably cannot catch,
 * because the root `trigger` and the shape under `result` are opaque to it,
 * are pinned here instead:
 *
 *   1. `trigger.<field>` — the payload is `{ type, triggerId, timestamp,
 *      data, metadata }`, so an input field lives at `trigger.data.<field>`
 *      and `trigger.<field>` renders null.
 *   2. A scheduled run gets `{ scheduleName, cron, input }` in
 *      `trigger.data`, and NO `dataSchema` defaults — so a scheduled
 *      template must not read `trigger.data.<field>` at all.
 *   3. An llm node exposes `result.text` (and `result.output.<f>` only with
 *      an `outputSchema`); an orchestrator or session node exposes
 *      `result.response`. The two are opposites and easy to swap.
 *   4. A foreach node truncates at `maxItems` in silence, so every foreach
 *      must declare the cap AND something downstream must read
 *      `truncatedCount`.
 */
import { describe, expect, it } from "vitest";
import {
  collectTemplatePaths,
  renderTemplate,
  validateWorkflowDefinition,
  type ForeachNode,
  type TemplateContext,
  type WorkflowDefinition,
  type WorkflowNode,
} from "@valet/workflow";
import type { ActionPlugin, ValetPlugin, WorkflowTemplate } from "@valet/engine";
import { bundledPlugins } from "../plugins/registry.gen.js";
import { nextFireAt } from "./schedule-service.js";
import { buildValidateEnvironment } from "./validation-env.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const actionPluginByService = new Map<string, { plugin: ValetPlugin; actionPlugin: ActionPlugin }>();
for (const plugin of bundledPlugins) {
  for (const actionPlugin of plugin.actions ?? []) {
    actionPluginByService.set(actionPlugin.service, { plugin, actionPlugin });
  }
}
const env = buildValidateEnvironment(actionPluginByService);

interface OwnedTemplate {
  pluginName: string;
  template: WorkflowTemplate;
  definition: WorkflowDefinition;
}

const owned: OwnedTemplate[] = bundledPlugins.flatMap((plugin) =>
  (plugin.templates ?? []).map((template) => ({
    pluginName: plugin.name,
    template,
    // Narrowed here rather than at the manifest: `WorkflowTemplate.definition`
    // is `unknown` so the engine gains no dependency on @valet/workflow. The
    // "is a dag/v1 definition" assertion runs as its own test below, before
    // anything reads `.nodes`.
    definition: template.definition as WorkflowDefinition,
  })),
);

/** Payload keys a `{{ trigger.… }}` path may name (`WorkflowTriggerPayload`). */
const TRIGGER_PAYLOAD_KEYS = new Set(["type", "triggerId", "timestamp", "data", "metadata"]);

/** `LlmResult` keys. `response` is NOT one of them — that is the session shape. */
const LLM_RESULT_KEYS = new Set(["text", "output", "usage"]);

/** Settled `session`/`orchestrator` result keys. `text` is NOT one — that is the llm shape. */
const SUBMISSION_RESULT_KEYS = new Set(["sessionId", "response", "output"]);

/** `ForeachResult` keys. */
const FOREACH_RESULT_KEYS = new Set([
  "items",
  "count",
  "inputCount",
  "truncatedCount",
  "completedCount",
  "skippedCount",
  "failedCount",
]);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Every node a template may reference, keyed by id — top-level nodes plus
 * foreach body nodes, which checkpoint under their own id.
 */
function nodesById(definition: WorkflowDefinition): Map<string, WorkflowNode> {
  const map = new Map<string, WorkflowNode>();
  for (const node of definition.nodes) {
    map.set(node.id, node);
    if (node.type === "foreach") map.set(node.body.id, node.body);
  }
  return map;
}

/** Walk a JSON value and collect the template paths in every string leaf. */
function pathsInJson(value: unknown, out: string[][]): void {
  if (typeof value === "string") {
    out.push(...collectTemplatePaths(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) pathsInJson(entry, out);
    return;
  }
  if (isRecord(value)) {
    for (const entry of Object.values(value)) pathsInJson(entry, out);
  }
}

/**
 * Every path a definition reads. `if.left` and `edge.when` are bare
 * expressions rather than templates, so they are wrapped before collection —
 * the parser is the same one underneath.
 */
function referencedPaths(definition: WorkflowDefinition): string[][] {
  const out: string[][] = [];
  for (const node of definition.nodes) {
    if (node.type === "if") {
      for (const condition of node.conditions) out.push(...collectTemplatePaths(`{{ ${condition.left} }}`));
      continue;
    }
    pathsInJson(node, out);
  }
  for (const edge of definition.edges) {
    if (edge.when !== undefined) out.push(...collectTemplatePaths(`{{ ${edge.when} }}`));
  }
  return out;
}

/** Declared property names of an `outputSchema`, or null when it declares none. */
function schemaProperties(schema: Record<string, unknown> | undefined): Set<string> | null {
  if (schema === undefined) return null;
  const properties = schema.properties;
  if (!isRecord(properties)) return null;
  return new Set(Object.keys(properties));
}

function foreachNodes(definition: WorkflowDefinition): ForeachNode[] {
  return definition.nodes.filter((node): node is ForeachNode => node.type === "foreach");
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("plugin workflow templates", () => {
  it("at least one plugin contributes a template", () => {
    expect(owned.length).toBeGreaterThan(0);
  });

  it("template ids are unique across every loaded plugin", () => {
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const { pluginName, template } of owned) {
      const previous = seen.get(template.id);
      if (previous !== undefined) collisions.push(`"${template.id}" claimed by both ${previous} and ${pluginName}`);
      seen.set(template.id, pluginName);
    }
    expect(collisions).toEqual([]);
  });

  describe.each(owned)("$template.id (from $pluginName)", ({ template, definition }) => {
    it("carries a dag/v1 definition", () => {
      expect(isRecord(template.definition)).toBe(true);
      expect(definition.version).toBe("dag/v1");
      expect(Array.isArray(definition.nodes)).toBe(true);
      expect(Array.isArray(definition.edges)).toBe(true);
    });

    it("passes the definition validator, models and actions included", () => {
      const result = validateWorkflowDefinition(definition, env);
      // Print the validator's own messages on failure — they name the node
      // and the corrected path.
      expect(result.ok ? [] : result.errors).toEqual([]);
    });

    it("reads only real trigger-payload keys", () => {
      const wrong = referencedPaths(definition)
        .filter((segments) => segments[0] === "trigger")
        .filter((segments) => segments.length > 1 && !TRIGGER_PAYLOAD_KEYS.has(segments[1] ?? ""))
        .map((segments) => segments.join("."));
      expect(wrong).toEqual([]);
    });

    it("reads llm, session and foreach results with each one's own shape", () => {
      const byId = nodesById(definition);
      const wrong: string[] = [];
      for (const segments of referencedPaths(definition)) {
        if (segments[0] !== "nodes") continue;
        const node = byId.get(segments[1] ?? "");
        if (node === undefined) continue; // the validator already reports this
        const field = segments[3];
        if (field === undefined) continue; // whole result — always valid
        const path = segments.join(".");

        if (node.type === "llm") {
          if (!LLM_RESULT_KEYS.has(field)) {
            wrong.push(`${path} — an llm result holds ${[...LLM_RESULT_KEYS].join(", ")}`);
            continue;
          }
          if (field === "output") {
            const properties = schemaProperties(node.outputSchema);
            if (properties === null) {
              wrong.push(`${path} — reads .output from an llm node with no outputSchema`);
            } else if (segments[4] !== undefined && !properties.has(segments[4])) {
              wrong.push(`${path} — "${segments[4]}" is not declared by that node's outputSchema`);
            }
          }
        }

        if (node.type === "orchestrator" || node.type === "session") {
          if (!SUBMISSION_RESULT_KEYS.has(field)) {
            wrong.push(`${path} — a ${node.type} result holds ${[...SUBMISSION_RESULT_KEYS].join(", ")}`);
            continue;
          }
          if (field === "output") {
            const properties = schemaProperties(node.outputSchema);
            if (properties === null) {
              wrong.push(`${path} — reads .output from a ${node.type} node with no outputSchema`);
            } else if (segments[4] !== undefined && !properties.has(segments[4])) {
              wrong.push(`${path} — "${segments[4]}" is not declared by that node's outputSchema`);
            }
          }
        }

        if (node.type === "foreach" && !FOREACH_RESULT_KEYS.has(field)) {
          wrong.push(`${path} — a foreach result holds ${[...FOREACH_RESULT_KEYS].join(", ")}`);
        }
      }
      expect(wrong).toEqual([]);
    });

    it("caps every foreach and reports what the cap dropped", () => {
      const loops = foreachNodes(definition);
      const uncapped = loops.filter((node) => node.maxItems === undefined).map((node) => node.id);
      expect(uncapped).toEqual([]);

      const reported = new Set(
        referencedPaths(definition)
          .filter((segments) => segments[0] === "nodes" && segments[3] === "truncatedCount")
          .map((segments) => segments[1] ?? ""),
      );
      const silent = loops.filter((node) => !reported.has(node.id)).map((node) => node.id);
      expect(silent).toEqual([]);
    });

    it("takes its inputs the way its trigger actually delivers them", () => {
      const triggerNode = definition.nodes.find((node) => node.type === "trigger");
      const declaresInputs = triggerNode?.type === "trigger" && triggerNode.dataSchema !== undefined;
      const readsInputFields = referencedPaths(definition).some(
        (segments) => segments[0] === "trigger" && segments[1] === "data",
      );

      if (template.schedule !== undefined) {
        // A scheduled run puts { scheduleName, cron, input } in
        // `trigger.data` and applies no dataSchema defaults. Either habit
        // silently reads null on the nightly run.
        expect(readsInputFields).toBe(false);
        expect(declaresInputs).toBe(false);
      } else if (readsInputFields) {
        expect(declaresInputs).toBe(true);
      }
    });

    it("labels every declared input", () => {
      const triggerNode = definition.nodes.find((node) => node.type === "trigger");
      if (triggerNode?.type !== "trigger" || triggerNode.dataSchema === undefined) return;
      const unlabelled = Object.entries(triggerNode.dataSchema)
        .filter(([, field]) => field.hidden !== true && (field.label === undefined || field.label === ""))
        .map(([name]) => name);
      expect(unlabelled).toEqual([]);
    });

    it("carries card copy the gallery can render", () => {
      expect(template.name.length).toBeGreaterThan(0);
      expect(template.description.length).toBeGreaterThan(0);
      expect(template.category.length).toBeGreaterThan(0);
      expect(template.steps.length).toBeGreaterThan(0);
    });

    it("arms a schedule that parses", () => {
      if (template.schedule === undefined) return;
      const next = nextFireAt(template.schedule.cron, template.schedule.timezone ?? "UTC", Date.now());
      expect(next.ok ? null : next.error).toBeNull();
    });
  });
});

// ─── The addressing rule itself ──────────────────────────────────────────────

describe("dag/v1 template addressing", () => {
  const context: TemplateContext = {
    trigger: { type: "manual", timestamp: "2026-08-15T00:00:00.000Z", data: { q: "hello" }, metadata: {} },
    nodes: {
      think: { result: { text: "T", usage: {} }, output: { text: "T", usage: {} } },
      agent: {
        result: { sessionId: "s1", response: "R" },
        output: { sessionId: "s1", response: "R" },
      },
      loop: {
        result: { items: [], count: 0, inputCount: 7, truncatedCount: 2 },
        output: { items: [], count: 0, inputCount: 7, truncatedCount: 2 },
      },
    },
  };

  it("reads a trigger input under data, and nothing above it", () => {
    expect(renderTemplate("{{ trigger.data.q }}", context)).toBe("hello");
    expect(renderTemplate("{{ trigger.q }}", context)).toBeNull();
    expect(renderTemplate("{{ trigger.timestamp }}", context)).toBe("2026-08-15T00:00:00.000Z");
  });

  it("reads an llm node at result.text, through either alias", () => {
    expect(renderTemplate("{{ nodes.think.result.text }}", context)).toBe("T");
    expect(renderTemplate("{{ nodes.think.output.text }}", context)).toBe("T");
  });

  it("does not resolve the shapes v1 used", () => {
    expect(renderTemplate("{{ nodes.think.result.data }}", context)).toBeNull();
    expect(renderTemplate("{{ nodes.think.result.response }}", context)).toBeNull();
  });

  it("reads a session or orchestrator node at result.response", () => {
    expect(renderTemplate("{{ nodes.agent.result.response }}", context)).toBe("R");
    expect(renderTemplate("{{ nodes.agent.result.text }}", context)).toBeNull();
  });

  it("reads a foreach aggregate, truncation included", () => {
    expect(renderTemplate("{{ nodes.loop.result.inputCount }}", context)).toBe(7);
    expect(renderTemplate("{{ nodes.loop.result.truncatedCount }}", context)).toBe(2);
  });

  it("keeps the value's type in a single-expression field and stringifies in mixed text", () => {
    expect(renderTemplate("{{ nodes.loop.result.items }}", context)).toEqual([]);
    expect(renderTemplate("count: {{ nodes.loop.result.inputCount }}", context)).toBe("count: 7");
  });
});
