import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadSkillFromMarkdown, type ValetPlugin } from "@valet/engine";
import { slackPlugin } from "./actions/actions.js";
import { slackFilterOptionResolvers } from "./transport/filter-options.js";
import { slackTransportFactory } from "./transport/transport.js";
import { slackTriggerDefs } from "./triggers.js";

// Re-exported so the api's Slack app manifest can pin its bot-event
// subscriptions against the event types these triggers actually match.
export { slackTriggerEventTypes } from "./triggers.js";

const skillMd = readFileSync(fileURLToPath(new URL("../skills/slack-tools/SKILL.md", import.meta.url)), "utf8");

const plugin: ValetPlugin = {
  name: "slack",
  version: "0.1.0",
  description: "Slack integration for messages, channels, and users",
  actions: [slackPlugin],
  triggers: slackTriggerDefs,
  transports: [slackTransportFactory],
  filterOptionResolvers: slackFilterOptionResolvers,
  skills: [loadSkillFromMarkdown(skillMd, "plugin", "slack-tools")],
  identityLink: {
    provider: "slack",
    instructions: "In Slack, open a DM with the Valet app and send: link <code>",
    // The "DM me" and "Find me by name" DM: the person types this code into
    // Valet, as in v1. The host redeems it only from the web app of the
    // user who asked, so a picked member who replies with it links nothing.
    // The code span stops mrkdwn from reading `_` in the code as italics;
    // a base64url code holds no `<` for the span path to restore raw.
    // The "10 minutes" copy must match the api's CODE_TTL_MS
    // (packages/api/src/channels/identity-links.ts) — asserted in
    // packages/api/src/routes/identity-links.test.ts.
    deliveryDm: ({ code }) =>
      `Your Valet link code is \`${code}\`. Enter it in Valet to link this Slack account. The code expires in 10 minutes. If you did not ask Valet to link an account, ignore this message.`,
    // "Sign in with Slack": the slack-user OAuth connect records the Slack
    // user id as this identity link, with no code to carry.
    oauthService: "slack-user",
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
