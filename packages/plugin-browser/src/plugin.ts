import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadSkillFromMarkdown, type ValetPlugin } from "@valet/engine";
import { browserPlugin } from "./actions.js";

const browserMd = readFileSync(fileURLToPath(new URL("../skills/browser/SKILL.md", import.meta.url)), "utf8");

const plugin: ValetPlugin = {
  name: "browser",
  version: "0.1.0",
  actions: [browserPlugin],
  skills: [loadSkillFromMarkdown(browserMd, "plugin", "browser")],
};

export default plugin;
