/**
 * `/api/skills` — read-only catalog of the markdown skills the assembled
 * plugin set ships. Modeled on `routes/plugins.ts`: it reflects
 * `providers.plugins` and owns no state of its own. There is no skills
 * table; the list changes only when the plugin set changes.
 *
 * The listing iterates the plugin array (not `pluginSessionExtras`'s
 * flattened `skills`) so every row can name its owning plugin. The detail
 * route adds the markdown body; it never fills `{{placeholder}}` values,
 * because reading a skill is not invoking it — the `skill` tool does that
 * (see `plugins/skill-tool.ts`).
 */
import { Hono } from "hono";
import type { SkillSource, ValetPlugin } from "@valet/engine";
import type { AppEnv } from "../env.js";
import type { GetSkillResponse, ListSkillsResponse, SkillSummary } from "../wire/types.js";

export const skillsRouter = new Hono<AppEnv>();

interface OwnedSkill {
  plugin: string;
  skill: SkillSource;
}

function ownedSkills(plugins: ValetPlugin[]): OwnedSkill[] {
  return plugins.flatMap((plugin) =>
    (plugin.skills ?? []).map((skill) => ({ plugin: plugin.name, skill })),
  );
}

function toSummary({ plugin, skill }: OwnedSkill): SkillSummary {
  return {
    name: skill.name,
    ...(skill.description === undefined ? {} : { description: skill.description }),
    plugin,
    takesArgs: skill.argsSchema !== undefined,
  };
}

skillsRouter.get("/", (c) => {
  const resp: ListSkillsResponse = {
    skills: ownedSkills(c.var.providers.plugins).map(toSummary),
  };
  return c.json(resp);
});

skillsRouter.get("/:name", (c) => {
  const name = c.req.param("name");
  const found = ownedSkills(c.var.providers.plugins).find((entry) => entry.skill.name === name);
  if (!found) {
    return c.json(
      { error: `skill "${name}" not found. Open /skills to see the installed skills.` },
      404,
    );
  }
  const resp: GetSkillResponse = { ...toSummary(found), content: found.skill.content };
  return c.json(resp);
});
