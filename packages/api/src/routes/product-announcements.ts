import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { requirePrincipal, requireUser } from "../middleware/auth.js";
import { acknowledgeProductAnnouncement, pendingProductAnnouncements } from "../services/product-announcements.js";

export const productAnnouncementsRouter = new Hono<AppEnv>();
productAnnouncementsRouter.get("/", async (c) => {
  const user = requireUser(c);
  const principal = requirePrincipal(c);
  if (!user || !principal) return c.json({ error: "Sign in to view product announcements." }, 401);
  if (principal.type !== "user") return c.json({ announcements: [] });
  return c.json({ announcements: await pendingProductAnnouncements(c.var.providers, user.id, user.orgId) });
});
productAnnouncementsRouter.post("/:id/acknowledge", async (c) => {
  const user = requireUser(c);
  const principal = requirePrincipal(c);
  if (!user || !principal) return c.json({ error: "Sign in to view product announcements." }, 401);
  if (principal.type !== "user") return c.json({ error: "Sign in with a user account to dismiss announcements." }, 403);
  const acknowledged = await acknowledgeProductAnnouncement(c.var.providers, user.id, user.orgId, c.req.param("id"));
  if (!acknowledged) return c.json({ error: "This announcement is unavailable. Refresh the page." }, 404);
  return c.json({ acknowledged: true });
});
