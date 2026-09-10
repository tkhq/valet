import { Type } from "typebox";
import type { ActionPlugin, PluginAction, PluginActionContext } from "@valet/engine";
import { TelegramApi } from "./transport/api.js";
import { markdownToTelegramHtml } from "./transport/format.js";

function chatIdFromOrigin(ctx: PluginActionContext): string | null {
  const key = ctx.origin?.channelType === "telegram" ? ctx.origin.threadKey : "";
  const prefix = "telegram:";
  if (!key.startsWith(prefix)) return null;
  const chatId = key.slice(prefix.length);
  return chatId === "" || chatId.includes(":") ? null : chatId;
}

const replyParameters = Type.Object({
  text: Type.String({ minLength: 1, description: "The reply text in Markdown." }),
});

const replyToOrigin: PluginAction<typeof replyParameters> = {
  id: "telegram.reply_to_origin",
  name: "Reply to Origin",
  description:
    "Reply in the Telegram chat this turn came from. Use it for later updates and final results. On an addressed turn, the first assistant text posts automatically unless this action sends the first reply.",
  riskLevel: "medium",
  parameters: replyParameters,
  execute: async (args, ctx) => {
    const chatId = chatIdFromOrigin(ctx);
    if (!chatId) {
      return { success: false, error: "This turn did not come from a Telegram chat, so there is nothing to reply to." };
    }
    const token = (await ctx.credentials.get())?.accessToken;
    if (!token) {
      return { success: false, error: "Connect the Telegram bot in organization settings to reply." };
    }
    const result = await new TelegramApi(token).sendMessage({
      chatId,
      html: markdownToTelegramHtml(args.text),
    });
    return { success: true, data: { chatId, messageId: result.messageId } };
  },
};

export const telegramPlugin: ActionPlugin = {
  service: "telegram",
  description: "Telegram channel actions",
  actions: [replyToOrigin],
};
