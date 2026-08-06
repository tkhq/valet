import { tool } from "@opencode-ai/plugin"

export default tool({
  description:
    "Create or update a memory file. " +
    "Memories persist across conversations and sandbox restarts. " +
    "Use paths to organize: preferences/, projects/<name>/, workflows/, journal/, notes/, people/. " +
    "Files under preferences/ are auto-pinned (never pruned). " +
    "Create requires `content`; omit `content` on an existing path to update metadata only. " +
    "Reserved names: 'index.md' and 'log.md' are auto-generated for a directory — use 'overview.md' " +
    "instead; 'lib/' is reserved for mounted libraries — write under notes/ or projects/ instead.",
  args: {
    path: tool.schema
      .string()
      .min(1)
      .describe(
        "File path (no leading slash). Examples: 'preferences/coding-style.md', " +
        "'projects/valet/repo.md', 'notes/team.md'",
      ),
    content: tool.schema
      .string()
      .optional()
      .describe(
        "The file content (markdown recommended). Required when creating a new path. " +
        "Omit to update only metadata (type/description/tags/resource/sensitivity/origin/expires) " +
        "on an existing file.",
      ),
    type: tool.schema
      .string()
      .optional()
      .describe(
        "Free-form short type label (no fixed taxonomy — stored verbatim). Directory defaults when " +
        "omitted: preferences/ -> preference, projects/ -> project-note, workflows/ -> workflow, " +
        "journal/ -> journal-entry, people/ -> person, notes/ and everything else -> note. Only set " +
        "this to override the directory default (e.g. reclassify a file after a move).",
      ),
    description: tool.schema
      .string()
      .optional()
      .describe(
        "One-line summary used for search/index rendering. Set it when the title/first line doesn't " +
        "already say what this file is about.",
      ),
    tags: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe(
        "Tags for filtering and search. Reuse existing tags where possible (near-duplicates like " +
        "case/plural/typo variants get flagged on first use — check existing tags before inventing one).",
      ),
    resource: tool.schema
      .string()
      .optional()
      .describe(
        "The canonical URL of the external asset this memory is about — set it for memories about a " +
        "specific repo/PR/issue/page, and search by resource first to update instead of duplicate.",
      ),
    sensitivity: tool.schema
      .enum(["private", "shareable"])
      .optional()
      .describe("'shareable' for team-useful knowledge — default private."),
    origin: tool.schema
      .enum(["user-stated", "inferred", "imported"])
      .optional()
      .describe("'user-stated' when the user explicitly said it — beats inferred on conflict."),
    expires: tool.schema
      .string()
      .optional()
      .describe("ISO date for ephemeral facts. Pass '' to clear an existing expiry."),
  },
  async execute(args, ctx) {
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" }
      if (ctx?.sessionID) {
        headers["x-valet-thread-id"] = ctx.sessionID
      }
      const res = await fetch("http://127.0.0.1:9001/api/memory", {
        method: "PUT",
        headers,
        body: JSON.stringify({
          path: args.path,
          content: args.content,
          type: args.type,
          description: args.description,
          tags: args.tags,
          resource: args.resource,
          sensitivity: args.sensitivity,
          origin: args.origin,
          expires: args.expires,
        }),
      })

      if (!res.ok) {
        const errText = await res.text()
        return `Failed to write: ${errText}`
      }

      const data = (await res.json()) as {
        file: { path: string; version: number; pinned: boolean; content: string; type: string }
        warnings?: string[]
      }

      const sizeKb = (data.file.content.length / 1024).toFixed(1)
      const pin = data.file.pinned ? " [pinned]" : ""
      const typeStr = data.file.type ? ` (${data.file.type})` : ""
      const lines = [`Written: ${data.file.path} (v${data.file.version}, ${sizeKb} KB)${pin}${typeStr}`]
      for (const w of data.warnings ?? []) {
        lines.push(w)
      }
      return lines.join("\n")
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Failed to write memory: ${msg}`
    }
  },
})
