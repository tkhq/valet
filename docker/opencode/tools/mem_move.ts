import { tool } from "@opencode-ai/plugin"

export default tool({
  description:
    "Move or rename a memory file, rewriting inbound links in referencing files. " +
    "Use this instead of write+rm when reorganizing — it preserves history (source session, " +
    "creation time) and keeps the link graph consistent.",
  args: {
    from: tool.schema.string().min(1).describe("Current path of the file to move."),
    to: tool.schema
      .string()
      .min(1)
      .describe("New path. Must not already exist. Subject to the same reserved-name rules as mem_write."),
  },
  async execute(args, ctx) {
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" }
      if (ctx?.sessionID) {
        headers["x-valet-thread-id"] = ctx.sessionID
      }
      const res = await fetch("http://127.0.0.1:9001/api/memory/move", {
        method: "POST",
        headers,
        body: JSON.stringify({ from: args.from, to: args.to }),
      })

      if (!res.ok) {
        const errText = await res.text()
        return `Failed to move: ${errText}`
      }

      const data = (await res.json()) as {
        result: {
          from: string
          to: string
          pinnedBefore: boolean
          pinnedAfter: boolean
          type: string
          typeDefaultForDest: string
          referencersUpdated: number
          referencersSkipped: string[]
        }
      }
      const r = data.result

      const lines = [`Moved: ${r.from} -> ${r.to}`]

      if (r.pinnedBefore !== r.pinnedAfter) {
        lines.push(
          r.pinnedAfter
            ? "now pinned — auto-loaded at session start"
            : "no longer pinned — subject to the cap",
        )
      }

      if (r.type && r.typeDefaultForDest && r.type !== r.typeDefaultForDest) {
        lines.push(`type remains '${r.type}' — pass type via mem_write to reclassify`)
      }

      if (r.referencersUpdated > 0) {
        lines.push(`${r.referencersUpdated} referencing files updated`)
      }

      if (r.referencersSkipped.length > 0) {
        lines.push(
          `⚠ ${r.referencersSkipped.length} referencing file${r.referencersSkipped.length !== 1 ? "s" : ""} skipped (concurrent edit — re-run mem_links to check): ${r.referencersSkipped.join(", ")}`,
        )
      }

      return lines.join("\n")
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Failed to move memory: ${msg}`
    }
  },
})
