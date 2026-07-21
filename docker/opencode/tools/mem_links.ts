import { tool } from "@opencode-ai/plugin"

interface LinkNeighbor {
  path: string
  title: string
  type: string
  description: string
  context?: string
  phantom: boolean
  relation: "out" | "in" | "session"
}

export default tool({
  description:
    "Traverse the memory link graph from a file: what it links to, what links to it, and its " +
    "session siblings (other memories written in the same conversation). " +
    "Use this to orient on ongoing work before starting on a project or topic.",
  args: {
    path: tool.schema.string().min(1).describe("File path to traverse from."),
    direction: tool.schema
      .enum(["out", "in", "both"])
      .default("both")
      .describe("'out' = files this one links to, 'in' = files linking to this one, 'both' = both."),
    depth: tool.schema
      .number()
      .min(1)
      .max(3)
      .default(1)
      .describe("How many hops to traverse (1-3). Edge context (the linking line) is only available at depth 1."),
    include_journal: tool.schema
      .boolean()
      .default(false)
      .describe("Let journal entries propagate traversal beyond depth 1 (excluded by default — high-volume, low-signal)."),
  },
  async execute(args) {
    try {
      const params = new URLSearchParams({
        path: args.path,
        direction: args.direction ?? "both",
        depth: String(args.depth ?? 1),
      })
      if (args.include_journal) params.set("includeJournal", "true")

      const res = await fetch(`http://localhost:9000/api/memory/links?${params.toString()}`)
      if (!res.ok) {
        const errText = await res.text()
        return `Failed to fetch links: ${errText}`
      }

      const data = (await res.json()) as { neighbors: LinkNeighbor[][]; truncated: boolean }

      const nonEmptyRings = data.neighbors.filter((ring) => ring.length > 0)
      if (nonEmptyRings.length === 0) {
        return `No linked files found for ${args.path}`
      }

      const lines: string[] = [`Links from ${args.path}:`]
      for (let i = 0; i < data.neighbors.length; i++) {
        const ring = data.neighbors[i]
        if (ring.length === 0) continue
        const depthLabel = i + 1

        const siblings = ring.filter((n) => n.relation === "session")
        const rest = ring.filter((n) => n.relation !== "session")

        if (rest.length > 0) {
          lines.push(`\nDepth ${depthLabel}:`)
          for (const n of rest) {
            const dir = n.relation === "out" ? "→" : "←"
            const phantomTag = n.phantom ? " [phantom — target not created]" : ""
            const typeTag = n.type ? ` (${n.type})` : ""
            const title = n.title || n.path
            lines.push(`  ${dir} ${n.path} — ${title}${typeTag}${phantomTag}`)
            if (depthLabel === 1 && n.context) {
              lines.push(`      "${n.context}"`)
            }
            if (n.description) {
              lines.push(`      ${n.description}`)
            }
          }
        }

        if (siblings.length > 0) {
          lines.push(`\nSession siblings (depth ${depthLabel}, same conversation):`)
          for (const n of siblings) {
            const title = n.title || n.path
            lines.push(`  ~ ${n.path} — ${title}`)
          }
        }
      }

      if (data.truncated) {
        lines.push("\n(truncated — result hit the node cap)")
      }

      return lines.join("\n")
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Failed to fetch links: ${msg}`
    }
  },
})
