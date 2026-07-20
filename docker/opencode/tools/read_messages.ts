import { tool } from "@opencode-ai/plugin"
import { formatOutput, paginationHint, stripToolResults } from "./_format"

export default tool({
  description:
    "Read messages from another agent session's conversation. By default returns the most recent window of the conversation, oldest first, so the session's latest message is the last one shown. " +
    "Use this to check on a child session's progress, read its results, or monitor what it's working on. " +
    "Returns the child's assistant text plus tool names/args; full tool-call results are omitted to keep the output focused. " +
    "Pass 'after' to page forward from a timestamp instead, which returns the window that starts just after that cursor. " +
    "Only works with sessions belonging to the same user.",
  args: {
    session_id: tool.schema
      .string()
      .describe("The target session ID to read messages from"),
    limit: tool.schema
      .number()
      .optional()
      .describe("Size of the window to return (default 50)"),
    after: tool.schema
      .string()
      .optional()
      .describe("ISO timestamp cursor — only return messages after this time (for pagination)"),
  },
  async execute(args) {
    try {
      const params = new URLSearchParams({ sessionId: args.session_id })
      if (args.limit) params.set("limit", String(args.limit))
      if (args.after) params.set("after", args.after)

      const res = await fetch(
        `http://localhost:9000/api/session-messages?${params}`,
      )

      if (!res.ok) {
        const errText = await res.text()
        return `Failed to read messages: ${errText}`
      }

      const data = (await res.json()) as {
        messages: Array<Record<string, unknown>>
        hasMore?: boolean
      }

      if (!data.messages || data.messages.length === 0) {
        return "No messages found in this session."
      }

      const output = formatOutput(stripToolResults(data.messages))
      if (!data.hasMore) return output

      return `${output}\n\n${paginationHint(data.messages.length, args.after ? "after" : "recent")}`
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Failed to read messages: ${msg}`
    }
  },
})
