import { tool } from "@opencode-ai/plugin"

export default tool({
  description:
    "Notify the humans who own this session (persistent notification queue; may also post " +
    "to the team's channel for urgent kinds). Use for important async updates — completions, " +
    "escalations, questions, decisions needed — while people may be offline. There is no " +
    "addressing: the platform decides who is notified based on who owns this session.",
  args: {
    message_type: tool.schema
      .enum(["notification", "question", "escalation", "approval"])
      .optional()
      .describe("Notification type (default: notification; question/escalation/approval are urgent)"),
    content: tool.schema
      .string()
      .describe("Notification body"),
    context_session_id: tool.schema
      .string()
      .optional()
      .describe("Optional related session ID"),
    context_task_id: tool.schema
      .string()
      .optional()
      .describe("Optional related task ID"),
  },
  async execute(args) {
    if (!args.content?.trim()) {
      return "Error: content is required"
    }

    try {
      const res = await fetch("http://localhost:9000/api/notifications/emit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message_type: args.message_type,
          content: args.content,
          context_session_id: args.context_session_id,
          context_task_id: args.context_task_id,
        }),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => "")
        return `Error emitting notification: ${res.status} ${text}`.trim()
      }
      return "Notification sent."
    } catch (err) {
      return `Error emitting notification: ${err instanceof Error ? err.message : String(err)}`
    }
  },
})
