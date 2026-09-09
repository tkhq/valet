/**
 * `/api/changelog` serves the immutable manifest bundled with this release.
 * It performs no GitHub request. See the in-app changelog design.
 */
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { changelogManifest, changelogResponse } from "../changelog/manifest.js";
import type { GetChangelogResponse } from "../wire/types.js";

export const changelogRouter = new Hono<AppEnv>();

changelogRouter.get("/", (c) => {
  const body: GetChangelogResponse = changelogResponse(changelogManifest);
  return c.json(body);
});
