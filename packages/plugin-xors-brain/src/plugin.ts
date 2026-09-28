import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadSkillFromMarkdown, type ValetPlugin } from "@valet/engine";
import { brainActions } from "./actions.js";

// The brain itself is generated into src/brain-data.ts from the xors-brain
// repo (scripts/build.py), which withholds confidential entries. The skill
// tells the agent to search the brain before it answers and to keep
// internal facts away from clients.
const brainMd = readFileSync(fileURLToPath(new URL("../skills/xors-brain/SKILL.md", import.meta.url)), "utf8");

const plugin: ValetPlugin = {
  name: "xors-brain",
  version: "0.1.0",
  displayName: "XORS Brain",
  description: "The XORS company brain: clients, projects, offerings, GTM, decisions",
  actions: [brainActions],
  skills: [loadSkillFromMarkdown(brainMd, "plugin", "xors-brain")],
};

export default plugin;
