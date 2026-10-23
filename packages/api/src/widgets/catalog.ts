/**
 * The widgets the assistant can show in a thread, as a json-render catalog
 * (https://json-render.dev). The model writes a spec, a flat map of
 * elements that use only these components; the api validates it, and the
 * web draws it with Valet's own components (`components/session/widgets`).
 *
 * A widget shows; it never acts. A Button sends its `reply` text as the
 * person's next message, so anything with an effect goes through the
 * assistant and its approval prompts like any other request.
 *
 * The web imports this module as `@valet/api/widgets`, so it holds no
 * server-only code.
 */
import { defineCatalog, formatSpecIssues, validateSpec, type Spec } from "@json-render/core";
import { schema } from "@json-render/react/schema";
import { z } from "zod";

export const WIDGET_TOOL_NAME = "show_widget";

const status = z.enum(["needs_you", "working", "done", "failed"]);

const components = {
  Card: {
    props: z.object({ title: z.string().optional(), subtitle: z.string().optional() }),
    description: "A bordered container; children stack inside it.",
  },
  Stack: {
    props: z.object({ direction: z.enum(["row", "column"]).optional(), gap: z.enum(["sm", "md"]).optional() }),
    description: "Lays children out in a column (default) or a wrapping row.",
  },
  Heading: { props: z.object({ text: z.string() }), description: "A short heading." },
  Text: { props: z.object({ text: z.string(), muted: z.boolean().optional() }), description: "A paragraph. Markdown is not rendered." },
  Stat: {
    props: z.object({ label: z.string(), value: z.string(), detail: z.string().optional(), trend: z.enum(["up", "down"]).optional() }),
    description: "A big number with a label, like spend last month, and a detail line such as the comparison.",
  },
  Table: {
    props: z.object({
      columns: z.array(z.object({ key: z.string(), label: z.string(), align: z.enum(["left", "right"]).optional() })).max(8),
      rows: z.array(z.record(z.string(), z.union([z.string(), z.number()]))).max(50),
    }),
    description: "Rows of records, such as transactions. Right-align amounts.",
  },
  List: {
    props: z.object({
      items: z.array(z.object({
        title: z.string(), subtitle: z.string().optional(), meta: z.string().optional(),
        status: status.optional(), href: z.string().optional(),
      })).max(30),
    }),
    description: "Items with an optional status (needs_you, working, done, failed) and link.",
  },
  Quote: {
    props: z.object({
      text: z.string(), speaker: z.string(), time: z.string().optional(), source: z.string().optional(), takeaway: z.string().optional(),
    }),
    description: "A quote from a meeting or message: who said it, when, where from, and the takeaway.",
  },
  Event: {
    props: z.object({
      title: z.string(), start: z.string(), end: z.string().optional(), location: z.string().optional(),
      attendees: z.array(z.string()).max(20).optional(), note: z.string().optional(),
    }),
    description: "A calendar event. Times are display text, such as \"Tue 27 Oct, 16:00\".",
  },
  KeyValue: {
    props: z.object({ items: z.array(z.object({ label: z.string(), value: z.string() })).max(20) }),
    description: "Label and value pairs, such as the fields of a record.",
  },
  Badge: {
    props: z.object({ text: z.string(), tone: z.enum(["neutral", "accent", "success", "warning", "danger"]).optional() }),
    description: "A small status label.",
  },
  Progress: {
    props: z.object({ label: z.string(), value: z.number().min(0).max(100), detail: z.string().optional() }),
    description: "A labeled bar from 0 to 100.",
  },
  Heatmap: {
    props: z.object({ values: z.array(z.number().min(0)).max(371), label: z.string().optional() }),
    description: "An activity grid, one cell per day, oldest first, like a contribution graph.",
  },
  Button: {
    props: z.object({ label: z.string(), reply: z.string(), primary: z.boolean().optional() }),
    description: "Sends `reply` as the person's next message. Offer a next step; never act directly.",
  },
  Link: { props: z.object({ label: z.string(), href: z.string() }), description: "A link that opens in a new tab." },
  Divider: { props: z.object({}), description: "A horizontal rule." },
};

export const widgetCatalog = defineCatalog(schema, { components, actions: {} });

export type WidgetSpec = Spec;
export type WidgetComponent = keyof typeof components;

/** One line per component for the tool description: name, props, purpose. */
function componentLine(name: string, props: z.ZodObject, description: string): string {
  const fields = Object.entries(props.shape).map(([key, value]) => `${key}${value instanceof z.ZodOptional ? "?" : ""}`);
  return `- ${name}(${fields.join(", ")}): ${description}`;
}

export const WIDGET_TOOL_DESCRIPTION = [
  "Show the person a small card in the thread when a structured view answers faster than prose: a number with context, a short table, quotes from a meeting, an event, items with status, or an activity grid.",
  "The card is the answer: keep any text beside it to a sentence and do not repeat what it shows. A Button sends its reply text as the person's next message, so use it to offer a next step.",
  "spec is a flat map: { \"root\": \"<key>\", \"elements\": { \"<key>\": { \"type\": \"<Component>\", \"props\": { ... }, \"children\": [\"<key>\", ...] } } }. Every element needs children, [] when it has none.",
  "Components:",
  ...Object.entries(components).map(([name, def]) => componentLine(name, def.props, def.description)),
].join("\n");

/**
 * Checks a spec against the catalog and its own references (the root and
 * every child key exist). Returns the problems as text the model can act
 * on, or `undefined` when the spec is good.
 */
export function widgetSpecProblems(spec: unknown): string | undefined {
  const parsed = widgetCatalog.validate(spec);
  if (!parsed.success || !parsed.data) {
    const issues = parsed.error?.issues.slice(0, 6).map(issue => `${issue.path.join(".") || "spec"}: ${issue.message}`) ?? [];
    return `The widget spec does not match the components. Fix these and call ${WIDGET_TOOL_NAME} again:\n${issues.join("\n")}`;
  }
  // The catalog checks props against every component at once, so an
  // element's props must also match its own component.
  const propIssues: string[] = [];
  for (const [key, element] of Object.entries(parsed.data.elements)) {
    if (element.repeat !== undefined) return "The widget cannot use repeat. Write the items as explicit elements and call show_widget again.";
    const def = components[element.type as WidgetComponent];
    const result = def.props.safeParse(element.props);
    if (!result.success) {
      for (const issue of result.error.issues.slice(0, 3)) propIssues.push(`elements.${key}.props.${issue.path.join(".") || element.type}: ${issue.message}`);
    }
  }
  if (propIssues.length) {
    return `The widget spec does not match the components. Fix these and call ${WIDGET_TOOL_NAME} again:\n${propIssues.slice(0, 6).join("\n")}`;
  }
  const elements = parsed.data.elements;
  const keys = Object.keys(elements);
  if (keys.length > 100) return "The widget has too many elements. Use at most 100 elements and call show_widget again.";
  // Check every subtree, including unused ones. Reused children count each
  // time they render, so a small DAG cannot expand into an unbounded tree.
  for (const key of keys) {
    let expanded = 0;
    const path = new Set<string>();
    const visit = (id: string, depth: number): string | undefined => {
      if (path.has(id)) return "The widget has a cycle. Remove the circular child reference and call show_widget again.";
      if (depth > 24) return "The widget has too much nesting. Use at most 24 levels and call show_widget again.";
      if (++expanded > 256) return "The widget has too many expanded elements. Reduce repeated children and call show_widget again.";
      const element = elements[id];
      if (!element) return undefined;
      path.add(id);
      for (const child of element.children ?? []) {
        const problem = visit(child, depth + 1);
        if (problem) return problem;
      }
      path.delete(id);
      return undefined;
    };
    const problem = visit(key, 0);
    if (problem) return problem;
  }
  const structure = validateSpec(parsed.data);
  if (!structure.valid) {
    return `The widget spec has broken references. Fix these and call ${WIDGET_TOOL_NAME} again:\n${formatSpecIssues(structure.issues.filter(issue => issue.severity === "error"))}`;
  }
  return undefined;
}
