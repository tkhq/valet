import type { ValetPlugin } from "@valet/engine";
import { telegramPlugin } from "./actions.js";
import { telegramTransportFactory } from "./transport/transport.js";

const plugin: ValetPlugin = {
  name: "telegram",
  version: "0.1.0",
  description: "Telegram bot channel: orchestrator DMs, gates as inline keyboards, media",
  actions: [telegramPlugin],
  transports: [telegramTransportFactory],
  credentials: [
    {
      type: "bot_token",
      configKeys: ["accessToken"],
      connectLabel: "Connect Telegram bot",
      // The organization bot handles ingress and explicit replies. User-owned
      // sessions resolve this shared token through owner escalation.
      requires: { orgCredential: true },
    },
  ],
  identityLink: {
    provider: "telegram",
    instructions: "Tap the link or send /start <code> to the bot.",
    deepLink: ({ botUsername, code }) =>
      botUsername ? `https://t.me/${botUsername}?start=${code}` : null,
  },
};

export default plugin;
