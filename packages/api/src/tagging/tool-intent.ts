import { and, eq, inArray } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { externalCalls } from "../schema/index.js";
import { capSubjectText, defineDimension } from "./dimension.js";
import type { SubjectRenderer } from "./tagger.js";

export const toolIntentDimension = defineDimension({
  id: "tool_intent", mode: "single", open: true, subjectTypes: ["external_call"],
  instructions: "Classify why a person called a tool. Choose the underlying purpose, not the service or tool name. Code changes and code reviews are different purposes. Do not infer sensitive attributes.",
  seeds: [
    { key: "code_change", label: "Code changes", definition: "Implement or modify software, tests, or configuration to deliver a change." },
    { key: "code_review", label: "Code review", definition: "Review a proposed software change for correctness, security, or maintainability." },
    { key: "debug_investigate", label: "Debugging & investigation", definition: "Diagnose a bug, failure, alert, or unexpected behavior to identify its cause." },
    { key: "research_lookup", label: "Research & lookup", definition: "Find facts or reference material to answer a question or inform a decision." },
    { key: "communicate", label: "Communication", definition: "Write or deliver a message, email, or announcement to another person." },
    { key: "project_tracking", label: "Project tracking", definition: "Create or update issues, milestones, ownership, and progress records." },
    { key: "data_analysis", label: "Data analysis", definition: "Query, compare, summarize, or visualize data to produce analytical findings." },
    { key: "scheduling", label: "Scheduling", definition: "Arrange meetings, check availability, or manage calendar events." },
    { key: "automation_setup", label: "Automation setup", definition: "Create or modify workflows, triggers, schedules, or event subscriptions that automate future work." },
    { key: "knowledge_memory", label: "Knowledge & memory", definition: "Read, organize, or save durable internal knowledge, skills, or preferences." },
    { key: "delegation", label: "Delegation", definition: "Assign work to an assistant or follow up on delegated work and its decisions." },
    { key: "deploy_ops", label: "Deployment & operations", definition: "Deploy, release, or operate running services and infrastructure." },
    { key: "other", label: "Other", definition: "An unclear purpose or a purpose that does not fit an existing class." },
  ],
  rules: subject => {
    if (subject.text.trim() || !subject.command) return undefined;
    const root = subject.command.split(" ")[0];
    if (["threads", "sessions", "send", "chat", "gates"].includes(root ?? "")) return "delegation";
    if (subject.command === "status") return "other";
    return undefined;
  },
});

export function toolIntentRenderer(db: AppDb, orgId: string): SubjectRenderer {
  return async refs => {
    if (!refs.length) return [];
    const rows = await db.select().from(externalCalls).where(and(eq(externalCalls.orgId, orgId), inArray(externalCalls.id, refs.map(ref => ref.id))));
    return rows.map(row => ({ type: "external_call", id: row.id, text: capSubjectText(row.intent ?? ""), userId: row.userId,
      ownerType: row.ownerType, ownerId: row.ownerId, ...(row.surface === "cli" ? { command: row.name } : {}) }));
  };
}
