import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadSkillFromMarkdown, type ValetPlugin } from "@valet/engine";

const skillMd = readFileSync(
  fileURLToPath(new URL("../skills/design/SKILL.md", import.meta.url)),
  "utf8",
);

/**
 * Valet Design (docs/specs/2026-08-23-valet-design-design.md).
 *
 * This plugin ships the design skill and the template starter files. The
 * `design_*` tools are NOT plugin actions: they are engine ToolDefs built
 * API-side (`packages/api/src/engine/design-tools.ts`) and attached only
 * to `kind='design'` sessions — see the spec's §Tools for why. The pure
 * library code (vdid addressing, .dc.html parsing, serializers, template
 * access) is exported from `@valet/plugin-design/lib` for the API.
 */
const plugin: ValetPlugin = {
  name: "design",
  version: "0.1.0",
  displayName: "Valet Design",
  description: "Chat-driven authoring of pages, decks, and documents",
  skills: [loadSkillFromMarkdown(skillMd, "plugin", "design")],
};

export default plugin;
