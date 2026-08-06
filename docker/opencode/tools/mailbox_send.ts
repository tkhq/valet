import { tool } from "@opencode-ai/plugin"

export default tool({
  description:
    "Send a persistent message to another session or user via the notification queue. " +
    "Unlike send_message (which injects a real-time prompt), notifications are stored durably and " +
    "appear even if recipients are offline. Use this for escalations, questions, and async coordination. " +
    "You can address by session ID, user ID, or @handle.",
  args: {
    to_session_id: tool.schema
      .string()
      .optional()
      .describe("Target session ID to send the message to"),
    to_user_id: tool.schema
      .string()
      .optional()
      .describe("Target user ID to send the message to"),
    to_handle: tool.schema
      .string()
      .optional()
      .describe("Target @handle to send the message to (resolved to user ID)"),
    message_type: tool.schema
      .enum(["message", "notification", "question", "escalation", "approval"])
      .optional()
      .describe("Type of message (default: 'message'). Use 'escalation' for urgent items, 'question' for things needing a human decision."),
    content: tool.schema
      .string()
      .describe("The message content"),
    context_session_id: tool.schema
      .string()
      .optional()
      .describe("Session ID for context (e.g. the session this message is about)"),
    context_task_id: tool.schema
      .string()
      .optional()
      .describe("Task ID for context (e.g. the task this message relates to)"),
    reply_to_id: tool.schema
      .string()
      .optional()
      .describe("Message ID this is a reply to"),
  },
  async execute(args) {
    if (!args.to_session_id && !args.to_user_id && !args.to_handle) {
      return "Error: must specify at least one of to_session_id, to_user_id, or to_handle"
    }
    if (!args.content?.trim()) {
      return "Error: content is required"
    }

    try {
      const res = await fetch("http://127.0.0.1:9001/api/notifications/emit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to_session_id: args.to_session_id,
          to_user_id: args.to_user_id,
          to_handle: args.to_handle,
          message_type: args.message_type,
          content: args.content,
          context_session_id: args.context_session_id,
          context_task_id: args.context_task_id,
          reply_to_id: args.reply_to_id,
        }),
      })

      if (!res.ok) {
        const errText = await res.text()
        return `Failed to send notification: ${errText}`
      }

      const data = (await res.json()) as { notificationId?: string; messageId?: string }
      const id = data.notificationId || data.messageId
      return id
        ? `Notification sent (id: ${id})`
        : "Notification sent."
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Failed to send notification: ${msg}`
    }
  },
})
