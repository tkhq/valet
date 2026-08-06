import { tool } from "@opencode-ai/plugin"

// Sentinels & fenced-block shapes copied verbatim from
// packages/worker/src/lib/okf.ts (BACKLINKS_SENTINEL / NOTICE_SENTINEL /
// renderBacklinksBlock / renderNoticeBlock) — that file is the source of
// truth. `sanitizeBody` on the worker strips blocks by matching these exact
// strings byte-for-byte, so any drift here breaks the write(read(x)) law.
const BACKLINKS_SENTINEL =
  "<!-- valet:backlinks — auto-generated; anything in this block is not part of the file and is stripped on write -->"
const NOTICE_SENTINEL = "<!-- valet:notice — auto-generated; not part of the file -->"

interface LinkNeighbor {
  path: string
  title: string
  type: string
  description: string
  context?: string
  phantom: boolean
  relation: "out" | "in" | "session"
}

const JOURNAL_TYPE = "journal-entry"
const BACKLINKS_CAP = 10

/**
 * Mirrors okf.ts#renderBacklinksBlock's exact output shape. The worker's
 * `queryLinks('in', 1, false)` call (used to build the read envelope) doesn't
 * pre-collapse journal entries or sort by updated_at (LinkNeighbor carries no
 * timestamp) — this function does the same journal-collapse the worker's
 * renderer expects, using the neighbor order returned by the API and the
 * journal/<date>.md filename convention to derive "latest".
 */
function renderBacklinksBlock(neighbors: LinkNeighbor[]): string {
  // Session siblings (relation 'session') merely shared a source_session_id —
  // they are NOT inline links, so listing them under "Linked from" fabricates
  // backlinks. Collapse them to one summary line instead.
  const sessionSiblings = neighbors.filter((n) => n.relation === "session")
  const linked = neighbors.filter((n) => n.relation !== "session")

  const journalEntries = linked.filter((n) => n.type === JOURNAL_TYPE)
  const nonJournal = linked.filter((n) => n.type !== JOURNAL_TYPE)

  const shown = nonJournal.slice(0, BACKLINKS_CAP)
  const totalMore = Math.max(0, nonJournal.length - BACKLINKS_CAP)

  const lines = [BACKLINKS_SENTINEL, "# Linked from"]
  for (const link of shown) {
    lines.push(`- [${link.title || link.path}](/${link.path}) — ${link.context ?? ""}`)
  }
  if (journalEntries.length > 0) {
    const latest = journalEntries
      .map((j) => j.path)
      .sort()
      .at(-1)!
    const dateMatch = latest.match(/(\d{4}-\d{2}-\d{2})/)
    const latestLabel = dateMatch ? dateMatch[1] : latest
    lines.push(`- Referenced in ${journalEntries.length} journal entries, latest ${latestLabel}`)
  }
  if (totalMore > 0) {
    lines.push(`- …and ${totalMore} more (use mem_links)`)
  }
  if (sessionSiblings.length > 0) {
    lines.push(
      `- Written in the same session as ${sessionSiblings.length} other ${sessionSiblings.length === 1 ? "file" : "files"} — not inline links (use mem_links)`,
    )
  }
  return lines.join("\n") + "\n"
}

/** Mirrors okf.ts#renderNoticeBlock. */
function renderNoticeBlock(text: string): string {
  const prefixed = text.startsWith("⚠") ? text : `⚠ ${text}`
  return `${NOTICE_SENTINEL}\n${prefixed}\n`
}

export default tool({
  description:
    "Read a memory file or list a directory. " +
    "If the path ends with '/' or is empty, returns a directory listing. " +
    "If the path is a file (e.g. 'projects/valet/repo.md'), returns its rendered document plus " +
    "auto-generated backlinks/notice blocks (fenced — not part of the file; never write them back). " +
    "Use this to recall user preferences, project context, and past decisions.",
  args: {
    path: tool.schema
      .string()
      .default("")
      .describe(
        "Path to read. Examples: '' (root listing), 'preferences/' (list preferences), " +
        "'projects/valet/repo.md' (read file). Omit leading slash.",
      ),
  },
  async execute(args) {
    try {
      const path = args.path || ""
      const params = new URLSearchParams()
      if (path) params.set("path", path)

      const qs = params.toString()
      const res = await fetch(
        `http://127.0.0.1:9001/api/memory${qs ? `?${qs}` : ""}`,
      )

      if (!res.ok) {
        const errText = await res.text()
        return `Failed to read: ${errText}`
      }

      const data = (await res.json()) as {
        file?: unknown
        document?: string
        backlinks?: LinkNeighbor[]
        notices?: string[]
        files?: unknown[]
        listing?: { path: string; size: number; updatedAt: string; pinned: boolean }[]
        index?: string
      }

      // Directory listing: virtual OKF index + fenced stats trailer.
      if (data.listing || data.files) {
        const listing = data.listing ?? (data.files as { path: string; size: number; updatedAt: string; pinned: boolean }[])
        const parts: string[] = []
        if (data.index) parts.push(data.index)

        if (listing.length === 0) {
          if (parts.length === 0) return path ? `No files under ${path}` : "Memory is empty. No files stored yet."
        } else {
          const statLines = listing.map((f) => {
            const sizeKb = (f.size / 1024).toFixed(1)
            const ago = relativeTime(f.updatedAt)
            const pin = f.pinned ? " · pinned" : ""
            return `- ${f.path} · ${sizeKb} KB · ${ago}${pin}`
          })
          parts.push("```\n# Stats\n" + statLines.join("\n") + "\n```")
        }
        return parts.join("\n\n")
      }

      // File read.
      if (data.file) {
        const parts = [data.document ?? ""]
        parts.push(renderBacklinksBlock(data.backlinks ?? []))
        for (const notice of data.notices ?? []) {
          parts.push(renderNoticeBlock(notice))
        }
        return parts.join("\n")
      }

      return `File not found: ${path}`
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Failed to read memory: ${msg}`
    }
  },
})

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}
