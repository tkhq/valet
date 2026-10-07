/**
 * Agent onboarding pages, public and unauthenticated:
 *
 *   GET /agent-setup.md   setup steps a local coding agent follows
 *   GET /agent-skill.md   the `valet` skill the agent installs (SKILL.md)
 *
 * The onboarding approach is one link: a person tells their agent to read
 * `<instance>/agent-setup.md` and follow it. Each page fills `{{VALET_URL}}`
 * with this instance's public URL, so the commands are exact for the
 * instance that served them. The pages hold no secrets and no
 * per-user data.
 *
 * The markdown lives beside this file. The build inlines it
 * (`build/inline-assets.mjs`), so the bundle and the binary serve it too.
 */
import { readFileSync } from "node:fs";
import type { Context, Hono } from "hono";
import { publicUrlFromEnv } from "../channels/host.js";
import type { AppEnv } from "../env.js";

const SETUP = readFileSync(new URL("./agent-setup.md", import.meta.url), "utf8");
const SKILL = readFileSync(new URL("./valet-skill.md", import.meta.url), "utf8");

/** Fill the page template with the instance URL, without a trailing slash. */
export function renderOnboardingPage(template: string, valetUrl: string): string {
  return template.replaceAll("{{VALET_URL}}", valetUrl.replace(/\/+$/, ""));
}

export function mountOnboardingRoutes(app: Hono<AppEnv>): void {
  const serve = (template: string) => (c: Context<AppEnv>) => {
    const url = publicUrlFromEnv(process.env) ?? new URL(c.req.url).origin;
    c.header("Content-Type", "text/markdown; charset=utf-8");
    c.header("Cache-Control", "public, max-age=300");
    return c.body(renderOnboardingPage(template, url));
  };
  app.get("/agent-setup.md", serve(SETUP));
  app.get("/agent-skill.md", serve(SKILL));
}
