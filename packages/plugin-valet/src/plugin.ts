import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadSkillFromMarkdown, type ValetPlugin } from "@valet/engine";

const productKnowledgeMd = readFileSync(
  fileURLToPath(new URL("../skills/using-valet/SKILL.md", import.meta.url)),
  "utf8",
);

const plugin: ValetPlugin = {
  name: "valet",
  version: "0.1.0",
  skills: [loadSkillFromMarkdown(productKnowledgeMd, "plugin", "using-valet")],
};

export default plugin;
