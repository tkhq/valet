import { z } from "zod";
import type { ThreadProjects, ThreadProjectsOperation } from "@valet/shared";

const id = z.string().min(1).max(200).refine(value => !["__proto__", "constructor", "prototype"].includes(value));
const name = z.string().trim().min(1).max(100);
const threadIds = z.array(id).max(5000);
export const threadProjectsSchema: z.ZodType<ThreadProjects> = z.object({
  projects: z.array(z.object({ id, name, collapsed: z.boolean() }).strict()).max(200),
  pinned: threadIds,
  assignments: z.record(id, id).refine(value => Object.keys(value).length <= 5000),
  grouped: z.boolean(),
  collapsed: z.boolean(),
}).strict();

const operation: z.ZodType<ThreadProjectsOperation> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("create"), id, name, collapsed: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("rename"), id, name }).strict(),
  z.object({ type: z.literal("collapse-project"), id, collapsed: z.boolean() }).strict(),
  z.object({ type: z.literal("delete"), id, archivedThreadIds: threadIds }).strict(),
  z.object({ type: z.literal("assign"), threadId: id, projectId: id.nullable() }).strict(),
  z.object({ type: z.literal("pin"), threadId: id, pinned: z.boolean() }).strict(),
  z.object({ type: z.literal("grouped"), value: z.boolean() }).strict(),
  z.object({ type: z.literal("collapsed"), value: z.boolean() }).strict(),
  z.object({ type: z.literal("import"), value: threadProjectsSchema }).strict(),
]);

export const threadProjectsMutationSchema = z.object({ expectedViewerId: id, operations: z.array(operation).min(1).max(500) }).strict();
export const threadProjectsDocumentSchema = z.object({
  value: threadProjectsSchema,
  retiredProjects: z.array(id).max(20000),
  touchedAssignments: z.array(id).max(20000),
  touchedPins: z.array(id).max(20000),
  initialized: z.boolean(),
}).strict();
export type ThreadProjectsDocument = z.infer<typeof threadProjectsDocumentSchema>;
