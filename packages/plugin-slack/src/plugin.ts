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
  identityLink: {
    provider: "slack",
    instructions: "In Slack, open a DM with the Valet app and send: link <code>",
  },
  credentials: [
    {
      type: "bot_token",
      configKeys: ["accessToken"],
      connectLabel: "Connect Slack (bot token)",
      // The org Slack app (Settings → Organization → Slack) IS the
      // integration: webhook ingress, the channel transport, and session
      // tools all resolve the org credential by owner escalation. Members
      // never paste a bot token — before an admin connects, the service is
      // "unconfigured"; after, it is "org" (provided by the organization).
      // The personal path is the separate slack-user OAuth declaration.
      requires: { orgCredential: true },
    },
  ],
};

export default plugin;
