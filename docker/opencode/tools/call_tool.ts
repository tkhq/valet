import { tool } from "@opencode-ai/plugin"
import { formatOutput } from "./_format"
import { parseToolParams } from "./_params"

export default tool({
  description:
    "Call a tool by its ID with the given parameters. Use list_tools first to discover available tools and their required parameters.",
  args: {
    tool_id: tool.schema
      .string()
      .describe("The fully-qualified tool ID (e.g. 'gmail:send_email', 'github:create_issue')"),
    params: tool.schema
      .union([
        tool.schema.record(tool.schema.string(), tool.schema.unknown()),
        tool.schema.string(),
      ])
      .optional()
      .describe(
        "Parameters for the tool, as a JSON object matching the schema from list_tools. Pass the object directly — do not stringify it.",
      ),
    summary: tool.schema
      .string()
      .describe("A brief, human-readable summary of what this tool call will do and why. This is shown to the user for approval. Example: 'Send a Slack message to #engineering with the deployment status update'"),
  },
  async execute(args, ctx) {
    try {
      if (!args.tool_id) {
        return "Error: tool_id is required. Use list_tools to discover available tools."
      }
      if (!args.summary) {
        return "Error: summary is required. Provide a brief human-readable description of what this tool call does."
      }

      const parsed = parseToolParams(args.params)
      if (!parsed.ok) {
        return parsed.error
      }
      const params = parsed.params

      // Pass the calling OpenCode session id so the DO can resolve the
      // originating channel without falling back to a non-deterministic
      // "most recent processing row" guess when multiple threads are running
      // concurrently on this session.
      const headers: Record<string, string> = { "Content-Type": "application/json" }
      if (ctx?.sessionID) {
        headers["x-opencode-session-id"] = ctx.sessionID
      }

      const res = await fetch("http://127.0.0.1:9001/api/tools/call", {
        method: "POST",
        headers,
        body: JSON.stringify({ toolId: args.tool_id, params, summary: args.summary }),
      })

      if (!res.ok) {
        const errText = await res.text()
        return `Tool call failed: ${errText}`
      }

      const data = (await res.json()) as { result?: unknown; error?: string }
      if (data.error) {
        return `Tool error: ${data.error}`
      }

      if (data.result === undefined || data.result === null) {
        return "Tool executed successfully (no data returned)."
      }

      return formatOutput(data.result)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Failed to call tool: ${msg}`
    }
  },
})
