/**
 * The workflow as numbered steps in plain language: the reading view a person
 * uses to check what Valet built. Pure, so the order and the wording are
 * tested without a canvas.
 */
import type { WorkflowDefinition, WorkflowNode } from "../editor-model";

export interface Step {
  node: WorkflowNode;
  number: number;
  title: string;
  /** One line on what the step does. */
  summary: string;
  /** The earlier values this step reads, such as "Summarize (step 3)". */
  reads: string[];
  /** Where the run goes next, when it is not simply the following step. */
  next: string[];
}

export interface StepNames {
  service: (service: string) => string;
  model: (modelId: string) => string;
}

/** A model id the catalog does not name, made readable: "claude-sonnet-4-5" → "Claude Sonnet 4.5". */
export function modelLabel(id: string): string {
  const parts = id.replace(/^[^:/]+[:/]/, "").split(/[-_]/).filter(Boolean);
  const words: string[] = [];
  for (const part of parts) {
    const last = words.at(-1);
    if (/^\d+$/.test(part) && last !== undefined && /\d$/.test(last)) words[words.length - 1] = `${last}.${part}`;
    else words.push(/^\d/.test(part) ? part : part[0]!.toUpperCase() + part.slice(1));
  }
  return words.join(" ") || id;
}

/** `fetch_meetings` → "Fetch meetings". */
export function humanize(id: string): string {
  const words = id.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim().toLowerCase();
  return words ? words[0]!.toUpperCase() + words.slice(1) : id;
}

/** Steps in run order: a step comes after every step that leads to it, and
 * ties keep the order the definition lists them in. */
export function orderSteps(definition: WorkflowDefinition): WorkflowNode[] {
  const index = new Map(definition.nodes.map((node, i) => [node.id, i]));
  const incoming = new Map(definition.nodes.map((node) => [node.id, 0]));
  for (const edge of definition.edges) incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  const ready = definition.nodes.filter((node) => incoming.get(node.id) === 0);
  const ordered: WorkflowNode[] = [];
  while (ready.length > 0) {
    ready.sort((a, b) => (a.type === "trigger" ? -1 : b.type === "trigger" ? 1 : index.get(a.id)! - index.get(b.id)!));
    const node = ready.shift()!;
    ordered.push(node);
    for (const edge of definition.edges.filter((e) => e.from === node.id)) {
      const left = (incoming.get(edge.to) ?? 0) - 1;
      incoming.set(edge.to, left);
      const target = definition.nodes.find((n) => n.id === edge.to);
      if (left === 0 && target) ready.push(target);
    }
  }
  // A cycle leaves nodes unplaced; list them at the end rather than hide them.
  return [...ordered, ...definition.nodes.filter((node) => !ordered.includes(node))];
}

const REF = /\{\{\s*(trigger\.data\.([\w-]+)|nodes\.([\w-]+))[^}]*\}\}/g;

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

/** A `{{ nodes.check.result.output.ok }}` path as a person reads it: "Check › ok". */
export function pathLabel(path: string): string {
  const node = /^nodes\.([\w-]+)\.result(?:\.output)?(?:\.(.+))?$/.exec(path.trim());
  if (node) return [humanize(node[1]!), node[2]].filter(Boolean).join(" › ");
  const input = /^trigger\.data\.([\w-]+)$/.exec(path.trim());
  return input ? humanize(input[1]!) : path;
}

function outputFields(schema: unknown): string[] {
  if (!schema || typeof schema !== "object" || !("properties" in schema)) return [];
  const properties = schema.properties;
  return properties && typeof properties === "object" ? Object.keys(properties).map(humanize) : [];
}

function summarize(node: WorkflowNode, names: StepNames): string {
  switch (node.type) {
    case "trigger": {
      const inputs = Object.entries(node.dataSchema ?? {}).map(([key, field]) => field.label ?? humanize(key));
      return inputs.length > 0 ? `Starts the workflow with ${inputs.join(", ")}` : "Starts the workflow";
    }
    case "tool":
      return node.service && node.action
        ? `${names.service(node.service)} · ${humanize(node.action.replace(/^[\w-]+\./, ""))}`
        : "No action chosen";
    case "llm": {
      const fields = outputFields(node.outputSchema);
      return `Asks ${node.model ? names.model(node.model) : "the default model"}${fields.length ? ` · returns ${fields.join(", ")}` : ""}`;
    }
    case "orchestrator":
      return "Hands the work to a Valet thread";
    case "session":
      return "Runs an agent in its own sandbox";
    case "approval":
      return "Waits for a person to approve";
    case "if": {
      const conditions = (node.conditions ?? []).map((c) =>
        `${pathLabel(String(c.left ?? ""))} ${String(c.operation ?? "is").replace(/_/g, " ")} ${c.right === undefined ? "" : String(c.right)}`.trim());
      return conditions.length ? `Checks ${conditions.join(" and ")}` : "No condition set";
    }
    case "foreach":
      return node.items ? `Repeats for each item in ${pathLabel(node.items.replace(/^\{\{\s*|\s*\}\}$/g, ""))}` : "No list chosen";
    case "wait":
      return node.duration ? `Waits ${node.duration}` : "No duration set";
    case "set":
      return `Sets ${Object.keys(node.values ?? {}).map(humanize).join(", ") || "no values"}`;
    case "workflow":
      return node.workflowId ? "Runs another workflow" : "No workflow chosen";
    case "stop":
      return node.outcome === "failure" ? "Ends the run as failed" : "Ends the run";
  }
}

/** Every step with its number, plain summary, what it reads, and where it goes next. */
export function buildSteps(definition: WorkflowDefinition, names: StepNames): Step[] {
  const ordered = orderSteps(definition);
  const numberOf = new Map(ordered.map((node, i) => [node.id, i + 1]));
  return ordered.map((node, i) => {
    const reads = new Set<string>();
    const { id: _id, type: _type, ...fields } = node;
    for (const text of strings(fields)) {
      for (const match of text.matchAll(REF)) {
        if (match[2]) reads.add(`${humanize(match[2])} (input)`);
        else if (match[3] && numberOf.has(match[3])) reads.add(`${humanize(match[3])} (step ${numberOf.get(match[3])})`);
      }
    }
    const out = definition.edges.filter((edge) => edge.from === node.id);
    const branch = (label: string, to: string) => `${label} → step ${numberOf.get(to) ?? "?"}`;
    const next = out.some((edge) => edge.fromOutput)
      ? out.map((edge) => branch(edge.fromOutput === "true" ? (node.type === "approval" ? "Approved" : "Yes") : (node.type === "approval" ? "Denied" : "No"), edge.to))
      : out.length === 1 && numberOf.get(out[0]!.to) === i + 2 ? [] : out.map((edge) => branch("Then", edge.to));
    return { node, number: i + 1, title: humanize(node.id), summary: summarize(node, names), reads: [...reads], next };
  });
}
