/**
 * `/api/prompt-templates` — per-user slash-command templates (slash-commands
 * plan, Task 9). Names must match `/^[a-z][a-z0-9-]*$/` and must not collide
 * with BUILTIN_COMMAND_NAMES. One template per (userId, name) — PUT upserts.
 *
 * Auth: user scope required (requireUser gate, same as /api/me).
 */
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { BUILTIN_COMMAND_NAMES } from "@valet/engine";
import type { AppEnv } from "../env.js";
import { requireUser } from "../middleware/auth.js";
import { userPromptTemplates } from "../schema/index.js";
import type {
  ListPromptTemplatesResponse,
  PutPromptTemplateRequest,
  PutPromptTemplateResponse,
} from "../wire/types.js";

export const promptTemplatesRouter = new Hono<AppEnv>();

const NAME_RE = /^[a-z][a-z0-9-]*$/;
const BUILTIN_SET = new Set<string>(BUILTIN_COMMAND_NAMES);

// ── GET / — list all templates for the authenticated user ────────────────────

promptTemplatesRouter.get("/", async (c) => {
  const user = requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const { db } = c.var.providers;

  const rows = await db
    .select()
    .from(userPromptTemplates)
    .where(eq(userPromptTemplates.userId, user.id));

  const templates = rows.map((r) => ({
    name: r.name,
    ...(r.description != null ? { description: r.description } : {}),
    content: r.content,
  }));

  const resp: ListPromptTemplatesResponse = { templates };
  return c.json(resp);
});

// ── PUT /:name — upsert a template by name ───────────────────────────────────

promptTemplatesRouter.put("/:name", async (c) => {
  const user = requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const { db } = c.var.providers;

  const name = c.req.param("name");

  if (!NAME_RE.test(name)) {
    return c.json(
      { error: `"${name}" is not a valid command name. Names must match /^[a-z][a-z0-9-]*$/.` },
      400,
    );
  }

  if (BUILTIN_SET.has(name)) {
    return c.json(
      { error: `"${name}" is a reserved built-in command name. Pick a different name.` },
      400,
    );
  }

  let body: PutPromptTemplateRequest;
  try {
    body = (await c.req.json()) as PutPromptTemplateRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  if (typeof body.content !== "string" || body.content.length === 0) {
    return c.json({ error: "content is required" }, 400);
  }
  if (body.description !== undefined && typeof body.description !== "string") {
    return c.json({ error: "description must be a string" }, 400);
  }

  const now = Date.now();
  const description = body.description ?? null;

  await db
    .insert(userPromptTemplates)
    .values({
      id: randomUUID(),
      userId: user.id,
      name,
      description,
      content: body.content,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [userPromptTemplates.userId, userPromptTemplates.name],
      set: {
        description,
        content: body.content,
        updatedAt: now,
      },
    });

  const resp: PutPromptTemplateResponse = {
    name,
    ...(description != null ? { description } : {}),
    content: body.content,
  };
  return c.json(resp);
});

// ── DELETE /:name — remove a template ───────────────────────────────────────

promptTemplatesRouter.delete("/:name", async (c) => {
  const user = requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const { db } = c.var.providers;

  const name = c.req.param("name");

  await db
    .delete(userPromptTemplates)
    .where(and(eq(userPromptTemplates.userId, user.id), eq(userPromptTemplates.name, name)));

  return c.body(null, 204);
});

export type PromptTemplatesRouter = typeof promptTemplatesRouter;
