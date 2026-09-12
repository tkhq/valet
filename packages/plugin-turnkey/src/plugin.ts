import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadSkillFromMarkdown, type ValetPlugin } from "@valet/engine";
import { turnkeyActionPlugin } from "./actions/actions.js";

const skillMd = readFileSync(fileURLToPath(new URL("../skills/commit-signing/SKILL.md", import.meta.url)), "utf8");

/**
 * Commit signing through Turnkey (`docs/specs/2026-09-12-agent-commit-signing-design.md`).
 * No `credentials` declaration: the deployment credential comes from the
 * environment, and the per-user Turnkey sub-organization is created from
 * Settings, not connected like an integration.
 */
const plugin: ValetPlugin = {
  name: "turnkey",
  version: "0.1.0",
  displayName: "Turnkey",
  description: "Signed commits: a per-pull-request key in Turnkey, approved once by the user",
  actions: [turnkeyActionPlugin],
  skills: [loadSkillFromMarkdown(skillMd, "plugin", "turnkey")],
  gate: {
    label: "Commit signing",
    description: "Agents can ask for a Turnkey-held key and sign commits with it after the user approves.",
  },
};

export default plugin;
