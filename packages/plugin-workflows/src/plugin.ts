import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadSkillFromMarkdown, type ValetPlugin } from "@valet/engine";
import { workflowTemplates } from "./templates.js";

const workflowsMd = readFileSync(fileURLToPath(new URL("../skills/workflows/SKILL.md", import.meta.url)), "utf8");

const plugin: ValetPlugin = {
  name: "workflows",
  version: "0.1.0",
  skills: [loadSkillFromMarkdown(workflowsMd, "plugin", "workflows")],
  templates: workflowTemplates,
};

export default plugin;
