import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadSkillFromMarkdown, type ValetPlugin } from "@valet/engine";
import { gmailPlugin } from "./actions/actions.js";

const skillMd = readFileSync(fileURLToPath(new URL("../skills/gmail/SKILL.md", import.meta.url)), "utf8");

const plugin: ValetPlugin = {
  name: "gmail",
  version: "0.1.0",
  description: "Gmail integration for reading and sending emails",
  actions: [gmailPlugin],
  skills: [loadSkillFromMarkdown(skillMd, "plugin", "gmail")],
  credentials: [
    {
      type: "oauth2",
      // Copied verbatim from the legacy provider's oauthScopes.
      scopes: [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.send",
        "https://www.googleapis.com/auth/gmail.compose",
        "https://www.googleapis.com/auth/gmail.modify",
        "https://www.googleapis.com/auth/gmail.labels",
      ],
      configKeys: ["accessToken", "refreshToken"],
      connectLabel: "Connect Gmail",
      oauth: {
        mode: 'authorization_code',
        authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        clientIdEnv: 'GOOGLE_CLIENT_ID',
        clientSecretEnv: 'GOOGLE_CLIENT_SECRET',
        extraAuthParams: { access_type: 'offline', prompt: 'consent' },
      },
    },
  ],
};

export default plugin;
