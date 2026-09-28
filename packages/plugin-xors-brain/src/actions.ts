import { Type } from "typebox";
import { Value } from "typebox/value";
import type { ActionPlugin, PluginActionResult } from "@valet/engine";
import { SECTIONS, getDoc, listDocs, render, search } from "./search.js";
import { BUILT, DOCS, MAX_SENSITIVITY } from "./brain-data.js";

const sectionParam = Type.Optional(
  Type.Union(
    SECTIONS.map((s) => Type.Literal(s)),
    { description: "Limit to one brain section" },
  ),
);

const searchSchema = Type.Object({
  query: Type.String({ description: "Keywords, e.g. 'medicare compliance netsuite'" }),
  section: sectionParam,
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Max results (default 8)" })),
});

const getSchema = Type.Object({
  ids: Type.Array(Type.String(), { minItems: 1, maxItems: 8, description: "Entry ids" }),
});

const listSchema = Type.Object({ section: sectionParam });

/**
 * The brain is a read-only snapshot bundled at build time, so every action is
 * a pure lookup: no credential, no network, low risk.
 */
export const brainActions: ActionPlugin = {
  service: "brain",
  description: `XORS company brain — ${DOCS.length} entries, built ${BUILT}, sensitivity up to ${MAX_SENSITIVITY}`,
  actions: [
    {
      id: "brain.search",
      name: "Search the XORS brain",
      description:
        "Search the XORS company brain (clients, projects, offerings, pricing, stack, GTM playbooks, " +
        "pipeline, ops, decisions, people). Use it BEFORE answering anything about what XORS does, " +
        "has built, charges, or decided, and whenever a client or prospect is named. " +
        "Returns ranked entry ids with summaries; read full entries with brain.get.",
      riskLevel: "low",
      parameters: searchSchema,
      async execute(raw): Promise<PluginActionResult> {
        if (!Value.Check(searchSchema, raw)) return { success: false, error: "Invalid brain.search arguments" };
        const args = raw;
        const hits = search(args.query, { section: args.section, limit: args.limit });
        if (hits.length === 0) {
          return { success: true, data: "No brain entries match. Try broader keywords, or brain.list." };
        }
        return {
          success: true,
          data: hits
            .map(
              ({ doc, score }) =>
                `- ${doc.id} [${doc.section}/${doc.type}, ${doc.sensitivity}, score ${score.toFixed(2)}] ${doc.title}\n  ${doc.summary}`,
            )
            .join("\n"),
        };
      },
    },
    {
      id: "brain.get",
      name: "Read XORS brain entries",
      description:
        "Read full XORS brain entries by id (from brain.search or brain.list). " +
        "Check each entry's sensitivity: only 'public' content may go to clients or prospects.",
      riskLevel: "low",
      parameters: getSchema,
      async execute(raw): Promise<PluginActionResult> {
        if (!Value.Check(getSchema, raw)) return { success: false, error: "Invalid brain.get arguments" };
        return {
          success: true,
          data: raw.ids
            .map((id) => {
              const doc = getDoc(id);
              return doc ? render(doc) : `# ${id}\nNot found (or withheld because it is confidential).`;
            })
            .join("\n\n---\n\n"),
        };
      },
    },
    {
      id: "brain.list",
      name: "List XORS brain entries",
      description: "List XORS brain entries (id, title, status), optionally for one section.",
      riskLevel: "low",
      parameters: listSchema,
      async execute(raw): Promise<PluginActionResult> {
        if (!Value.Check(listSchema, raw)) return { success: false, error: "Invalid brain.list arguments" };
        return {
          success: true,
          data: listDocs(raw.section)
            .map((d) => `${d.section}  ${d.id}  (${d.status}, ${d.sensitivity})  ${d.title}`)
            .join("\n"),
        };
      },
    },
  ],
};
