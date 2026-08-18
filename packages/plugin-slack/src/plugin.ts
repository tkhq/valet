import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadSkillFromMarkdown, type ValetPlugin } from "@valet/engine";
import { slackPlugin } from "./actions/actions.js";
import { slackTransportFactory } from "./transport/transport.js";
import { slackTriggerDefs } from "./triggers.js";

const skillMd = readFileSync(fileURLToPath(new URL("../skills/slack-tools/SKILL.md", import.meta.url)), "utf8");

const plugin: ValetPlugin = {
  name: "slack",
  version: "0.1.0",
  description: "Slack integration for messages, channels, and users",
  actions: [slackPlugin],
  triggers: slackTriggerDefs,
  transports: [slackTransportFactory],
  skills: [loadSkillFromMarkdown(skillMd, "plugin", "slack-tools")],
  credentials: [
    {
      type: "bot_token",
      configKeys: ["accessToken"],
      connectLabel: "Connect Slack (bot token)",
      // The org Slack app (Settings → Organization → Slack) is the
      // integration's foundation: webhook ingress and the channel transport
      // need it. Without it a personal bot token gives a half-dead
      // integration, so the service is not offered until an admin connects
      // the org credential.
      requires: { orgCredential: true },
    },
  ],
};

export default plugin;
