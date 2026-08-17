/**
 * Contract tests for the seeded catalog — the templates the host ships
 * itself (`template-definitions.ts`), and the aggregation that puts them
 * beside the plugin-contributed ones.
 *
 * `template-definitions.test.ts` runs the same class of check over every
 * PLUGIN template, reading them off `bundledPlugins`. A seeded template
 * belongs to no plugin, so it never enters that suite. This one covers it,
 * and adds the three rules the seeded catalog holds itself to on top:
 *
 *   1. It calls no integration action. A seeded template must install on a
 *      deployment whatever set of plugins is loaded, and must run for a
 *      person who has connected nothing.
 *   2. It arms no schedule. A scheduled run puts `{ scheduleName, cron,
 *      input }` in `trigger.data` and applies NO `dataSchema` defaults, so
 *      a cron on any of these would read null every night forever.
 *   3. It hard-codes no person. Ownership and routing data arrive as
 *      workflow inputs, because a name baked into a shipped template is
 *      wrong within a month and takes a release to correct.
 */
import { describe, expect, it } from "vitest";
import {
  collectTemplatePaths,
  renderTemplate,
  validateWorkflowDefinition,
  type TemplateContext,
  type WorkflowDefinition,
  type WorkflowInputDefinition,
  type WorkflowNode,
} from "@valet/workflow";
import type { ValetPlugin, WorkflowTemplate } from "@valet/engine";
import { buildValidateEnvironment } from "./validation-env.js";
import { builtinWorkflowTemplates } from "./template-definitions.js";
import { CATALOG_SOURCE, findCatalogTemplate, listCatalogTemplates, toolNodesOf } from "./templates.js";

// A seeded template names no action, so the environment needs no action
// hook. The model hook is real: a model id that leaves the catalog must
// fail here rather than on somebody's first run.
const env = buildValidateEnvironment();

interface Seeded {
  template: WorkflowTemplate;
  definition: WorkflowDefinition;
}

const seeded: Seeded[] = builtinWorkflowTemplates.map((template) => ({
  template,
  // Narrowed here rather than at the manifest: `WorkflowTemplate.definition`
  // is `unknown` so the engine gains no dependency on @valet/workflow. The
  // "is a dag/v1 definition" assertion runs as its own test below.
  definition: template.definition as WorkflowDefinition,
}));

// ─── Helpers ─────────────────────────────────────────────────────────────

/** Payload keys a `{{ trigger.… }}` path may name (`WorkflowTriggerPayload`). */
const TRIGGER_PAYLOAD_KEYS = new Set(["type", "triggerId", "timestamp", "data", "metadata"]);

/** `LlmResult` keys. `response` is NOT one of them — that is the session shape. */
const LLM_RESULT_KEYS = new Set(["text", "output", "usage"]);

/** Settled `session`/`orchestrator` result keys. `text` is NOT one of them. */
const SUBMISSION_RESULT_KEYS = new Set(["sessionId", "response", "output"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

/** Every path a definition reads. `if.left` and `edge.when` are bare
 * expressions rather than templates, so they are wrapped before collection
 * — the parser underneath is the same one. */
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

function schemaProperties(schema: Record<string, unknown> | undefined): Set<string> | null {
  if (schema === undefined) return null;
  const properties = schema.properties;
  if (!isRecord(properties)) return null;
  return new Set(Object.keys(properties));
}

function triggerSchema(definition: WorkflowDefinition): Record<string, WorkflowInputDefinition> | undefined {
  const trigger = definition.nodes.find((node) => node.type === "trigger");
  return trigger?.type === "trigger" ? trigger.dataSchema : undefined;
}

function nodesById(definition: WorkflowDefinition): Map<string, WorkflowNode> {
  const map = new Map<string, WorkflowNode>();
  for (const node of definition.nodes) {
    map.set(node.id, node);
    if (node.type === "foreach") map.set(node.body.id, node.body);
  }
  return map;
}

// ─── The catalog ─────────────────────────────────────────────────────────

describe("seeded workflow catalog", () => {
  it("ships at least one template", () => {
    expect(seeded.length).toBeGreaterThan(0);
  });

  it("namespaces every id, so a plugin cannot claim one by accident", () => {
    const unnamespaced = seeded.map((s) => s.template.id).filter((id) => !id.startsWith("catalog."));
    expect(unnamespaced).toEqual([]);
  });

  it("gives every template a distinct id", () => {
    const ids = seeded.map((s) => s.template.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  describe.each(seeded)("$template.id", ({ template, definition }) => {
    it("carries a dag/v1 definition", () => {
      expect(isRecord(template.definition)).toBe(true);
      expect(definition.version).toBe("dag/v1");
      expect(Array.isArray(definition.nodes)).toBe(true);
      expect(Array.isArray(definition.edges)).toBe(true);
    });

    it("passes the definition validator, models included", () => {
      const result = validateWorkflowDefinition(definition, env);
      // Print the validator's own messages on failure — they name the node
      // and the corrected path.
      expect(result.ok ? [] : result.errors).toEqual([]);
    });

    it("calls no integration action, so a deployment can always offer it", () => {
      expect(toolNodesOf(definition).map((node) => `${node.service}.${node.action}`)).toEqual([]);
    });

    it("arms no schedule, because a scheduled run delivers none of its inputs", () => {
      expect(template.schedule).toBeUndefined();
    });

    it("reads only real trigger-payload keys", () => {
      const wrong = referencedPaths(definition)
        .filter((segments) => segments[0] === "trigger")
        .filter((segments) => segments.length > 1 && !TRIGGER_PAYLOAD_KEYS.has(segments[1] ?? ""))
        .map((segments) => segments.join("."));
      expect(wrong).toEqual([]);
    });

    it("declares and labels every trigger input it reads", () => {
      const schema = triggerSchema(definition);
      const undeclared: string[] = [];
      for (const segments of referencedPaths(definition)) {
        if (segments[0] !== "trigger" || segments[1] !== "data") continue;
        const field = segments[2];
        if (field === undefined || schema?.[field] === undefined) undeclared.push(segments.join("."));
      }
      expect(undeclared).toEqual([]);

      const unlabelled = Object.entries(schema ?? {})
        .filter(([, field]) => field.hidden !== true && (field.label === undefined || field.label === ""))
        .map(([name]) => name);
      expect(unlabelled).toEqual([]);
    });

    it("reads llm and orchestrator results with each one's own shape", () => {
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
          }
        }
      }
      expect(wrong).toEqual([]);
    });

    it("carries card copy the gallery can render", () => {
      expect(template.name.length).toBeGreaterThan(0);
      expect(template.description.length).toBeGreaterThan(0);
      expect(template.category.length).toBeGreaterThan(0);
      expect(template.steps.length).toBeGreaterThan(0);
    });

    it("settles every path at a stop node", () => {
      const outgoing = new Set(definition.edges.map((edge) => edge.from));
      const dangling = definition.nodes
        .filter((node) => node.type !== "stop" && !outgoing.has(node.id))
        .map((node) => node.id);
      expect(dangling).toEqual([]);
    });
  });
});

// ─── Reviewer routing, specifically ──────────────────────────────────────

describe("catalog.reviewer-routing", () => {
  const definition = builtinWorkflowTemplates.find((t) => t.id === "catalog.reviewer-routing")!
    .definition as WorkflowDefinition;

  it("takes the area-to-reviewer map as a required input, not as a constant", () => {
    const schema = triggerSchema(definition);
    expect(schema?.reviewerMap?.type).toBe("object");
    expect(schema?.reviewerMap?.required).toBe(true);
  });

  it("reads the map from the trigger when it routes", () => {
    const route = definition.nodes.find((node) => node.id === "route");
    expect(route?.type).toBe("llm");
    const paths = referencedPaths(definition).map((segments) => segments.join("."));
    expect(paths).toContain("trigger.data.reviewerMap");
  });

  it("sends to the reviewer the match produced, never to a name in the definition", () => {
    const notify = definition.nodes.find((node) => node.id === "notify_reviewer");
    expect(notify?.type).toBe("orchestrator");
    const prompt = notify?.type === "orchestrator" ? notify.prompt : "";
    expect(prompt).toContain("{{ nodes.route.result.output.reviewer }}");
    // A handle written into the definition would route every install to one
    // person, whatever map they supplied.
    expect(prompt).not.toMatch(/@[a-z][a-z0-9-]+/i);
  });

  it("branches on the miss instead of guessing a reviewer", () => {
    const branches = definition.edges.filter((edge) => edge.from === "has_reviewer");
    expect(branches.map((edge) => edge.fromOutput).sort()).toEqual(["false", "true"]);
    const miss = branches.find((edge) => edge.fromOutput === "false")!;
    expect(miss.to).toBe("report_gap");
  });

  it("keeps its example handles to placeholders", () => {
    const schema = triggerSchema(definition);
    const placeholder = schema?.reviewerMap?.placeholder ?? "";
    // Every handle in the example is a role, so nobody real is named and no
    // install inherits somebody else's team.
    const handles = placeholder.match(/@[a-z0-9-]+/gi) ?? [];
    expect(handles.length).toBeGreaterThan(0);
    expect(handles.filter((handle) => !handle.startsWith("@reviewer-"))).toEqual([]);
  });
});

// ─── Aggregation ─────────────────────────────────────────────────────────

const seededIds = builtinWorkflowTemplates.map((t) => t.id);

function pluginWith(id: string): ValetPlugin {
  return {
    name: "fixture",
    version: "0.0.1",
    templates: [
      {
        id,
        name: id,
        description: id,
        category: "test",
        apps: [],
        steps: ["one"],
        definition: { version: "dag/v1", nodes: [{ id: "t", type: "trigger" }], edges: [] },
      },
    ],
  };
}

describe("listCatalogTemplates", () => {
  it("puts plugin templates first and the seeded catalog after them", () => {
    const owned = listCatalogTemplates([pluginWith("fixture.one")]);
    expect(owned.map((o) => o.template.id)).toEqual(["fixture.one", ...seededIds]);
    expect(owned[0]!.pluginName).toBe("fixture");
    expect(owned[1]!.pluginName).toBe(CATALOG_SOURCE);
  });

  it("offers the seeded catalog even when no plugin is loaded", () => {
    expect(listCatalogTemplates([]).map((o) => o.template.id)).toEqual(seededIds);
  });

  it("throws when a plugin claims a seeded id, naming both sides", () => {
    expect(() => listCatalogTemplates([pluginWith(seededIds[0]!)])).toThrow(
      new RegExp(`${seededIds[0]!.replace(".", "\\.")}.*fixture.*${CATALOG_SOURCE}`, "s"),
    );
  });
});

describe("findCatalogTemplate", () => {
  it("finds a seeded template by id", () => {
    const found = findCatalogTemplate([], seededIds[0]!);
    expect(found?.template.id).toBe(seededIds[0]);
    expect(found?.pluginName).toBe(CATALOG_SOURCE);
  });

  it("finds a plugin template by id", () => {
    expect(findCatalogTemplate([pluginWith("fixture.one")], "fixture.one")?.pluginName).toBe("fixture");
  });

  it("reports an unknown id as not found", () => {
    expect(findCatalogTemplate([], "nope")).toBeNull();
  });
});

// ─── The addressing rule itself ──────────────────────────────────────────

describe("dag/v1 addressing", () => {
  const context: TemplateContext = {
    trigger: { type: "manual", timestamp: "2026-08-15T00:00:00.000Z", data: { area: "billing" }, metadata: {} },
    nodes: {
      route: {
        result: { text: "raw", output: { matched: true, reviewer: "@reviewer-one" } },
        output: { text: "raw", output: { matched: true, reviewer: "@reviewer-one" } },
      },
      notify: { result: { sessionId: "s1", response: "sent" }, output: { sessionId: "s1", response: "sent" } },
    },
  };

  it("reads a trigger input under data, and nothing above it", () => {
    expect(renderTemplate("{{ trigger.data.area }}", context)).toBe("billing");
    expect(renderTemplate("{{ trigger.area }}", context)).toBeNull();
  });

  it("reads a schema'd llm node under result.output", () => {
    expect(renderTemplate("{{ nodes.route.result.output.reviewer }}", context)).toBe("@reviewer-one");
    // The v1 shape. It resolves to nothing here, which is why a template
    // that uses it produces an empty prompt instead of an error.
    expect(renderTemplate("{{ nodes.route.data.reviewer }}", context)).toBeNull();
  });

  it("reads an orchestrator node at result.response, and never at result.text", () => {
    expect(renderTemplate("{{ nodes.notify.result.response }}", context)).toBe("sent");
    expect(renderTemplate("{{ nodes.notify.result.text }}", context)).toBeNull();
  });
});
