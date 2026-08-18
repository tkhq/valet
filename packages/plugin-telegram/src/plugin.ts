import type { ValetPlugin } from "@valet/engine";
import { telegramTransportFactory } from "./transport/transport.js";

const plugin: ValetPlugin = {
  name: "telegram",
  version: "0.1.0",
  description: "Telegram bot channel: orchestrator DMs, gates as inline keyboards, media",
  transports: [telegramTransportFactory],
  credentials: [
    {
      type: "bot_token",
      configKeys: ["accessToken"],
      connectLabel: "Connect Telegram bot",
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
