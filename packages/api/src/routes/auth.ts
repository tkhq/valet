import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import type { AuthMeResponse } from "../wire/types.js";

export const authRouter = new Hono<AppEnv>();

authRouter.get("/me", (c) => {
  const u = c.var.user;
  const body: AuthMeResponse = {
    user: { id: u.id, email: u.email, name: u.name },
  };
  return c.json(body);
});
