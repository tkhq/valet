import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadRoleFromMarkdown, loadSkillFromMarkdown, type ValetPlugin } from "@valet/engine";
import { BUNDLED_PERSONAS } from "./lib/personas.js";

// Ships the security engagement content: the runner skill (the cell loop a
// kind='security' session drives) and one role per bundled persona (what a
// cell-claimed child session runs under). The shared protocol contract
// lives at ../protocol/state-doc.md; the API serves it as the /protocol.md
// mount in the engagement tree. The pure plan/state-doc/persona/config library
// is under ./lib and is imported by the API directly (the "." export).
const runnerMd = readFileSync(
  fileURLToPath(new URL("../skills/security-engagement-runner/SKILL.md", import.meta.url)),
  "utf8",
);

const plugin: ValetPlugin = {
  name: "security",
  version: "0.1.0",
  // Opts into the org entitlement rail (plugin-entitlements design). An org
  // admin can turn Valet Security off, on for everyone, or on for named teams.
  gate: {
    label: "Valet Security",
    description: "AI security review of a repository — planned sweeps, findings, and a report.",
  },
  skills: [loadSkillFromMarkdown(runnerMd, "plugin", "security-engagement-runner")],
  // One RoleSpec per bundled persona. The host attaches ONLY the role whose
  // name matches a claimed cell's persona (see engine/host.ts).
  roles: BUNDLED_PERSONAS.map((p) => loadRoleFromMarkdown(p.roleMarkdown, "plugin", p.id)),
};

export default plugin;
