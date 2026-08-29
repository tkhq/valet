import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadSkillFromMarkdown, type ValetPlugin } from "@valet/engine";
import { githubPlugin } from "./actions/actions.js";
import { githubFilterOptionResolvers } from "./filter-options.js";
import { githubTemplates } from "./templates.js";
import { githubTriggerDefs } from "./triggers.js";

const skillMd = readFileSync(fileURLToPath(new URL("../skills/github/SKILL.md", import.meta.url)), "utf8");

const plugin: ValetPlugin = {
  name: "github",
  version: "0.1.0",
  description: "GitHub integration for PRs, issues, repos, and webhooks",
  actions: [githubPlugin],
  triggers: githubTriggerDefs,
  filterOptionResolvers: githubFilterOptionResolvers,
  skills: [loadSkillFromMarkdown(skillMd, "plugin", "github")],
  templates: githubTemplates,
  credentials: [
    {
      type: "oauth2",
      // The legacy provider's oauthScopes was `[]`: OAuth is handled by the
      // GitHub App's built-in OAuth client, so GitHub ignores the `scope`
      // param entirely — the user-to-server token inherits the app's
      // configured permissions intersected with the user's access.
      scopes: [],
      configKeys: ["accessToken"],
      connectLabel: "Connect GitHub (via GitHub App)",
    },
  ],
};

export default plugin;
