import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadRoleFromMarkdown, loadSkillFromMarkdown, type ValetPlugin } from "@valet/engine";

// Ships the security engagement content: the runner skill (the cell loop a
// kind='security' session drives) and the code-review persona role (what a
// cell-claimed child session runs under). The shared protocol contract
// lives at ../protocol/state-doc.md; the API serves it as the /protocol.md
// mount in the engagement tree. The pure plan/state-doc library is under
// ./lib and is imported by the API directly (the "." export).
const runnerMd = readFileSync(
  fileURLToPath(new URL("../skills/security-engagement-runner/SKILL.md", import.meta.url)),
  "utf8",
);
const codeReviewMd = readFileSync(
  fileURLToPath(new URL("../roles/code-review.md", import.meta.url)),
  "utf8",
);

const plugin: ValetPlugin = {
  name: "security",
  version: "0.1.0",
  skills: [loadSkillFromMarkdown(runnerMd, "plugin", "security-engagement-runner")],
  roles: [loadRoleFromMarkdown(codeReviewMd, "plugin", "code-review")],
};

export default plugin;
