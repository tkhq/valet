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

// The artifact-design skill (artifact-pages design, Styling): the design
// rules and copy-paste component system for `artifact_publish` html pages.
// It ships beside the memory skill because the publish tools live on the
// same surface; pages stay consistent across sessions by prompt-side
// guidance, never server-side styling — artifacts are self-contained.
const artifactDesignMd = readFileSync(
  fileURLToPath(new URL("../skills/artifact-design/SKILL.md", import.meta.url)),
  "utf8",
);

const plugin: ValetPlugin = {
  name: "memory",
  version: "0.1.0",
  skills: [
    loadSkillFromMarkdown(memoryMd, "plugin", "memory"),
    loadSkillFromMarkdown(artifactDesignMd, "plugin", "artifact-design"),
  ],
};

export default plugin;
