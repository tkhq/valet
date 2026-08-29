import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadSkillFromMarkdown, type ValetPlugin } from "@valet/engine";

// This plugin ships a SKILL (skills/assistants/SKILL.md — the how-to guide
// for the assistants.* and skills.* actions), not the actions themselves.
// The actions need the app db and the engine host, so they are host-defined
// (packages/api/src/assistants/actions.ts, assembled in providers/node.ts);
// content plugins stay portable.
const assistantsMd = readFileSync(
  fileURLToPath(new URL("../skills/assistants/SKILL.md", import.meta.url)),
  "utf8",
);

const plugin: ValetPlugin = {
  name: "assistants",
  version: "0.1.0",
  skills: [loadSkillFromMarkdown(assistantsMd, "plugin", "assistants")],
};

export default plugin;
