import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadSkillFromMarkdown, type ValetPlugin } from "@valet/engine";

const workflowsMd = readFileSync(fileURLToPath(new URL("../skills/workflows.md", import.meta.url)), "utf8");

const plugin: ValetPlugin = {
  name: "workflows",
  version: "0.1.0",
  skills: [loadSkillFromMarkdown(workflowsMd, "plugin")],
};

export default plugin;
