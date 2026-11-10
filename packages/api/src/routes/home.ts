import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { dismissHomeTask, ensureHomeThread, listHomeTasks } from "../home/service.js";
import type { DismissHomeTaskRequest, HomeConversationResponse, HomeTasksResponse } from "../wire/types.js";

export const homeRouter = new Hono<AppEnv>();

/** Only a person has a home conversation; an API key for a team does not. */
function personOf(c: { var: AppEnv["Variables"] }) {
  return c.var.principal.type === "user" ? { id: c.var.user.id, orgId: c.var.user.orgId } : null;
}

// Opens the person's home conversation, creating it on first use. It never
// submits a model turn.
homeRouter.post("/", async (c) => {
  const person = personOf(c);
  if (!person) return c.json({ error: "Home is for a person. Sign in with your own account." }, 403);
  const { session, thread } = await ensureHomeThread(c.var.providers, person);
  const home = { sessionId: session.id, threadId: thread.id };
  return c.json(home satisfies HomeConversationResponse);
});

homeRouter.get("/tasks", async (c) => {
  const person = personOf(c);
  if (!person) return c.json({ error: "Home is for a person. Sign in with your own account." }, 403);
  const body: HomeTasksResponse = await listHomeTasks(c.var.providers, person);
  return c.json(body);
});

const ID_MAX = 200;

/** A string id of 1 to `ID_MAX` characters, or undefined. */
function idField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= ID_MAX ? value : undefined;
}

// Crosses a thread out of the person's Tasks. It changes only their list.
homeRouter.post("/tasks/dismiss", async (c) => {
  const person = personOf(c);
  if (!person) return c.json({ error: "Home is for a person. Sign in with your own account." }, 403);
  const body = await c.req.json<Partial<Record<keyof DismissHomeTaskRequest, unknown>>>().catch(() => null);
  const sessionId = idField(body?.sessionId);
  const threadId = idField(body?.threadId);
  if (!sessionId || !threadId) return c.json({ error: "Send the task's sessionId and threadId from GET /api/home/tasks." }, 400);
  await dismissHomeTask(c.var.providers.db, person, { sessionId, threadId });
  return c.body(null, 204);
});
