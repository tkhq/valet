import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadSkillFromMarkdown, type ValetPlugin } from "@valet/engine";
import { slackUserActionPlugin } from "./actions/actions.js";
import { SLACK_USER_SCOPES, interpretSlackUserTokenResponse } from "./oauth.js";

const skillMd = readFileSync(fileURLToPath(new URL("../skills/slack-user/SKILL.md", import.meta.url)), "utf8");

const plugin: ValetPlugin = {
  name: "slack-user",
  version: "0.0.1",
  description: "Slack (personal) — per-user OAuth client acting AS the user.",
  actions: [slackUserActionPlugin],
  skills: [loadSkillFromMarkdown(skillMd, "plugin", "slack-user")],
  credentials: [
    {
      service: "slack-user",
      type: "oauth2",
      scopes: [...SLACK_USER_SCOPES],
      configKeys: ["accessToken"],
      connectLabel: "Connect Slack (personal)",
      oauth: {
        mode: "authorization_code",
        authorizationUrl: "https://slack.com/oauth/v2/authorize",
        tokenUrl: "https://slack.com/api/oauth.v2.access",
        clientIdEnv: "SLACK_CLIENT_ID",
        clientSecretEnv: "SLACK_CLIENT_SECRET",
        scopesParam: "user_scope",
        interpretTokenResponse: interpretSlackUserTokenResponse,
      },
    },
  ],
};

export default plugin;
