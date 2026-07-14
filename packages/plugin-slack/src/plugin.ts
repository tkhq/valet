import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadSkillFromMarkdown, type ValetPlugin } from "@valet/engine";
import { slackPlugin } from "./actions/actions.js";

const skillMd = readFileSync(fileURLToPath(new URL("../skills/slack-tools.md", import.meta.url)), "utf8");

const plugin: ValetPlugin = {
  name: "slack",
  version: "0.1.0",
  description: "Slack integration for messages, channels, and users",
  actions: [slackPlugin],
  skills: [loadSkillFromMarkdown(skillMd, "plugin", "slack")],
  credentials: [
    {
      type: "bot_token",
      configKeys: ["accessToken"],
      connectLabel: "Connect Slack (bot token)",
    },
  ],
};

export default plugin;
