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
    // The anchor DM for the "DM me" flow. It carries NO code — the code is
    // shown only on the authenticated Valet card, and the user carries it
    // into this DM (`link <code>`, the same command LINK_COMMAND_RE in
    // transport.ts parses). That trip is the ownership proof; a code in
    // this message would let a reply link an account the replier never
    // asked to link. The ignore-notice matters for the same reason: the
    // deliver endpoint can DM a member the caller picked by name.
    deliveryDm:
      "To link this Slack account to Valet, reply to this message with: `link <code>` — your code is shown in Valet. The code expires in 10 minutes. If you did not ask Valet to link an account, ignore this message.",
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
