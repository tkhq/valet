/**
 * The in-app tour (`services/tutorial.ts`):
 *
 *   GET  /api/tutorial        the caller's tour state and whether it is due
 *   PUT  /api/tutorial        save the resume step, or finish or skip
 *   POST /api/tutorial/reset  org admin: show the tour to every member again
 */
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { requireOrgAdmin } from "./_org-admin.js";
import { getTutorialState, resetTutorialForOrg, TutorialInputError, updateTutorial } from "../services/tutorial.js";
import type { ResetTutorialResponse, UpdateTutorialRequest } from "../wire/types.js";

export const tutorialRouter = new Hono<AppEnv>();

/** Only a person takes the tour; an API key for a team does not. */
function personOf(c: { var: AppEnv["Variables"] }) {
  return c.var.principal.type === "user" ? { id: c.var.user.id, orgId: c.var.user.orgId } : null;
}

tutorialRouter.get("/", async (c) => {
  const person = personOf(c);
  if (!person) return c.json({ error: "The tour is for a person. Sign in with your own account." }, 403);
  return c.json(await getTutorialState(c.var.providers.db, c.var.providers.tutorialVersion, person));
});

tutorialRouter.put("/", async (c) => {
  const person = personOf(c);
  if (!person) return c.json({ error: "The tour is for a person. Sign in with your own account." }, 403);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Send a JSON body with step, or outcome and the versions you saw." }, 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return c.json({ error: "Send a JSON body with step, or outcome and the versions you saw." }, 400);
  }
  try {
    // Each field is checked in updateTutorial before it is used.
    return c.json(await updateTutorial(c.var.providers.db, c.var.providers.tutorialVersion, person, body as UpdateTutorialRequest));
  } catch (err) {
    if (err instanceof TutorialInputError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

tutorialRouter.post("/reset", async (c) => {
  const gate = await requireOrgAdmin(c);
  if (gate) return gate;
  const orgVersion = await resetTutorialForOrg(c.var.providers.db, c.var.user.orgId);
  return c.json({ orgVersion } satisfies ResetTutorialResponse);
});
