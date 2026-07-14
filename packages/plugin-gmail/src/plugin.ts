import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadSkillFromMarkdown, type ValetPlugin } from "@valet/engine";
import { gmailPlugin } from "./actions/actions.js";

const skillMd = readFileSync(fileURLToPath(new URL("../skills/gmail.md", import.meta.url)), "utf8");

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
    },
  ],
};

export default plugin;
