import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadSkillFromMarkdown, type ValetPlugin } from "@valet/engine";

// NOTE: despite the package name, packages/plugin-personas ships a *skill*
// (skills/personas.md — a how-to guide for creating/configuring personas and
// managing the skill library), not a persona/role definition. There is no
// personas/*.md directory to load via loadRoleFromMarkdown; the only content
// file present is skill-shaped, so it's loaded as a SkillSource like the
// other content plugins.
const personasMd = readFileSync(fileURLToPath(new URL("../skills/personas/SKILL.md", import.meta.url)), "utf8");

const plugin: ValetPlugin = {
  name: "personas",
  version: "0.1.0",
  skills: [loadSkillFromMarkdown(personasMd, "plugin", "personas")],
};

export default plugin;
