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
    // The anchor DM for the "DM me" flow. It carries NO code and no
    // code-shaped token — the exact reply line (deliveryReply below) is
    // shown only on the authenticated Valet card, and the user carries it
    // into this DM. That trip is the ownership proof; a code in this
    // message would let a reply link an account the replier never asked to
    // link. The ignore-notice matters for the same reason: the deliver
    // endpoint can DM a member the caller picked by name. Plain prose
    // only: backticks and angle brackets would hit the mrkdwn code-span
    // path, which restores span content to Slack unescaped.
    // The "10 minutes" copy must match the api's CODE_TTL_MS
    // (packages/api/src/channels/identity-links.ts) — asserted in
    // packages/api/src/routes/identity-links.test.ts.
    deliveryDm:
      "To link this Slack account to Valet, reply to this message with the command shown in Valet. The command expires in 10 minutes. If you did not ask Valet to link an account, ignore this message.",
    // The exact reply the card shows next to the anchor DM note. Never
    // DMed. Must stay parseable by LINK_COMMAND_RE (transport.ts) —
    // asserted in plugin.test.ts.
    deliveryReply: ({ code }) => `link ${code}`,
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
