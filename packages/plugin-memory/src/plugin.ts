import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadSkillFromMarkdown, type ValetPlugin } from "@valet/engine";

// Ships the memory-curation skill (skills/memory/SKILL.md): playbooks for
// working on the memory store itself with the `mem_*` tools. Day-to-day
// remembering is covered by the orchestrator persona's memory rules
// (packages/api/src/orchestrator/persona.ts); this skill is the deeper
// guide for curation sessions, dedup, journal distillation, and link
// hygiene. Revived from the v1 memory-compaction plugin's skill, rewritten
// for the v2 tool surface (seven mem_* tools, derived link graph, no
// prune cap).
const memoryMd = readFileSync(fileURLToPath(new URL("../skills/memory/SKILL.md", import.meta.url)), "utf8");

const plugin: ValetPlugin = {
  name: "memory",
  version: "0.1.0",
  skills: [loadSkillFromMarkdown(memoryMd, "plugin", "memory")],
};

export default plugin;
