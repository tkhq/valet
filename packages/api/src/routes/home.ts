import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { ensureHomeThread, ensureMorningBrief, listHomeTasks, markHomeTaskDone } from "../home/service.js";
import { createWorkflowSchedule } from "../workflows/schedule-service.js";
import type { HomeConversationResponse, HomeTasksResponse } from "../wire/types.js";

export const homeRouter = new Hono<AppEnv>();

/** Only a person has a home conversation; an API key for a team does not. */
function personOf(c: { var: AppEnv["Variables"] }) {
  return c.var.principal.type === "user" ? { id: c.var.user.id, orgId: c.var.user.orgId } : null;
}

// Opens the person's home conversation, creating it and its morning brief
// routine on first use. It never submits a model turn.
homeRouter.post("/", async (c) => {
  const person = personOf(c);
  if (!person) return c.json({ error: "Home is for a person. Sign in with your own account." }, 403);
  const { session, thread } = await ensureHomeThread(c.var.providers, person);
  const home = { sessionId: session.id, threadId: thread.id };
  const { db, engineCredentials, plugins, onePassword } = c.var.providers;
  // The brief is a convenience: a failure here must not block home.
  await ensureMorningBrief(db, person, home, (input) =>
    createWorkflowSchedule({ db, credentials: engineCredentials, plugins, onePassword }, { userId: person.id, orgId: person.orgId }, input),
  ).catch((err: unknown) => console.error("[home] could not create the morning brief routine", err));
  return c.json(home satisfies HomeConversationResponse);
});

homeRouter.get("/tasks", async (c) => {
  const person = personOf(c);
  if (!person) return c.json({ error: "Home is for a person. Sign in with your own account." }, 403);
  const body: HomeTasksResponse = await listHomeTasks(c.var.providers, person);
  return c.json(body);
});

homeRouter.post("/tasks/:taskId/done", async (c) => {
  const person = personOf(c);
  if (!person) return c.json({ error: "Home is for a person. Sign in with your own account." }, 403);
  const done = await markHomeTaskDone(c.var.providers.db, person, c.req.param("taskId"));
  return done ? c.body(null, 204) : c.json({ error: "Task not found, or it is already done." }, 404);
});
