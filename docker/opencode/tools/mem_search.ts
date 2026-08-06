import { tool } from "@opencode-ai/plugin"

// Models to try in order of preference
const RERANK_MODELS = [
  {
    key: "ANTHROPIC_API_KEY",
    provider: "anthropic",
    model: "claude-haiku-4-5-20251001",
  },
  {
    key: "OPENAI_API_KEY",
    provider: "openai",
    model: "gpt-4o-mini",
  },
] as const

export default tool({
  description:
    "Search memory files using full-text search with optional LLM re-ranking. " +
    "Returns the most relevant files for the query, with match-aware snippets. " +
    "Use this before responding to any new request that may involve known projects, " +
    "preferences, workflows, or past decisions. " +
    "Expired files are excluded by default — pass include_expired to see them (ranked last).",
  args: {
    query: tool.schema
      .string()
      .min(1)
      .describe("Search query. Examples: 'valet deployment', 'auth cloudflare', 'coding preferences'"),
    path: tool.schema
      .string()
      .optional()
      .describe("Optional path prefix to scope the search. Example: 'projects/valet/'"),
    rerank: tool.schema
      .boolean()
      .default(true)
      .describe("Whether to re-rank results with LLM (default true, set false for speed)"),
    limit: tool.schema
      .number()
      .default(5)
      .describe("Max results to return after re-ranking (default 5)"),
    include_expired: tool.schema
      .boolean()
      .default(false)
      .describe(
        "Include expired files in results, annotated [EXPIRED] and ranked last. " +
        "Default false — silently omitting them would otherwise read as amnesia.",
      ),
  },
  async execute(args) {
    try {
      // 1. Fetch top-20 candidates from FTS
      const params = new URLSearchParams({ query: args.query, limit: "20" })
      if (args.path) params.set("path", args.path)
      if (args.include_expired) params.set("include_expired", "true")

      const res = await fetch(
        `http://127.0.0.1:9001/api/memory/search?${params.toString()}`,
      )
      if (!res.ok) {
        const errText = await res.text()
        return `Search failed: ${errText}`
      }

      const data = (await res.json()) as {
        results: Candidate[]
        suppressedExpired?: number
      }

      if (!data.results || data.results.length === 0) {
        return `No matches for "${args.query}"`
      }

      const candidates = data.results
      const finalLimit = args.limit ?? 5

      // 2. Re-rank if enabled and we have an LLM available. The reranker only
      // ever reorders by relevance score — expired-last is re-applied after,
      // since an LLM score has no notion of expiry and would otherwise
      // resurrect expired results into the middle of the pack.
      let ranked = candidates
      if (args.rerank !== false && candidates.length > 1) {
        const reranked = await rerankWithLLM(args.query, candidates)
        if (reranked) ranked = reranked
      }
      ranked = stableSortExpiredLast(ranked)

      // 3. Format output
      const top = ranked.slice(0, finalLimit)
      const lines = [
        `Found ${candidates.length} matches for "${args.query}", showing top ${top.length}:\n`,
      ]
      for (let i = 0; i < top.length; i++) {
        const r = top[i]
        const scoreStr = (r.relevance * 100).toFixed(0) + "%"
        const expiredTag = r.expired ? "[EXPIRED] " : ""
        lines.push(`${i + 1}. ${expiredTag}${r.path}  (score: ${scoreStr})`)
        lines.push(`   ${metadataLine(r)}`)
        const desc = descriptionLine(r)
        if (desc) lines.push(`   ${desc}`)
        lines.push(`   ${r.snippet.replace(/\n/g, "\n   ")}`)
        lines.push("")
      }
      if (data.suppressedExpired && data.suppressedExpired > 0) {
        lines.push(
          `(${data.suppressedExpired} expired file${data.suppressedExpired !== 1 ? "s" : ""} matched — pass include_expired: true)`,
        )
      }
      return lines.join("\n")
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Search failed: ${msg}`
    }
  },
})

// ─── Result formatting ───────────────────────────────────────────────────────

interface Candidate {
  path: string
  snippet: string
  relevance: number
  title: string
  type: string
  description: string
  tags: string[]
  resource: string
  inboundLinks: number
  expired: boolean
}

/** Compact metadata line: `[type] path · tags: a,b,+2 · resource: host/path · ←3` (omits empty parts). */
function metadataLine(r: Candidate): string {
  const parts: string[] = []
  if (r.type) parts.push(`[${r.type}] ${r.path}`)
  else parts.push(r.path)

  if (r.tags && r.tags.length > 0) {
    const shown = r.tags.slice(0, 4)
    const extra = r.tags.length - shown.length
    parts.push(`tags: ${shown.join(",")}${extra > 0 ? `,+${extra}` : ""}`)
  }

  if (r.resource) {
    parts.push(`resource: ${formatResource(r.resource)}`)
  }

  if (r.inboundLinks > 0) {
    parts.push(`←${r.inboundLinks}`)
  }

  return parts.join(" · ")
}

function formatResource(resource: string): string {
  try {
    const u = new URL(resource)
    const path = u.pathname === "/" ? "" : u.pathname
    return `${u.host}${path}`
  } catch {
    return resource
  }
}

/** Description line, omitted when empty or when the snippet already starts with it. */
function descriptionLine(r: Candidate): string | null {
  if (!r.description) return null
  if (r.snippet.startsWith(r.description)) return null
  return r.description
}

/** Stable sort that moves expired results to the bottom without reordering within each group. */
function stableSortExpiredLast(candidates: Candidate[]): Candidate[] {
  const notExpired = candidates.filter((c) => !c.expired)
  const expired = candidates.filter((c) => c.expired)
  return [...notExpired, ...expired]
}

// ─── LLM Re-ranking ──────────────────────────────────────────────────────────

async function rerankWithLLM(
  query: string,
  candidates: Candidate[],
): Promise<Candidate[] | null> {
  // Find the first available provider
  const provider = RERANK_MODELS.find((m) => !!process.env[m.key])
  if (!provider) return null

  const docList = candidates
    .map((c, i) => `[${i + 1}] ${c.path} — ${c.title}\n${c.description}\n${c.snippet}`)
    .join("\n\n")

  const prompt = `You are a relevance judge. Score each document's relevance to the query.

Query: "${query}"

Documents:
${docList}

Respond with ONLY a JSON array of scores, one number per document in order.
Each score: 0.0 (not relevant) to 1.0 (highly relevant).
Example for 3 docs: [0.9, 0.2, 0.7]`

  try {
    let scores: number[] | null = null

    if (provider.provider === "anthropic") {
      scores = await callAnthropic(provider.model, prompt, process.env[provider.key]!)
    } else if (provider.provider === "openai") {
      scores = await callOpenAI(provider.model, prompt, process.env[provider.key]!)
    }

    if (!scores || scores.length !== candidates.length) return null

    // Re-sort candidates by LLM score, preserving all other fields.
    return candidates
      .map((c, i) => ({ ...c, relevance: scores![i] ?? c.relevance }))
      .sort((a, b) => b.relevance - a.relevance)
  } catch {
    // Re-ranking failure is non-fatal — return null to use FTS order
    return null
  }
}

const RERANK_TIMEOUT_MS = 8000

async function callAnthropic(model: string, prompt: string, apiKey: string): Promise<number[] | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), RERANK_TIMEOUT_MS)
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      signal: controller.signal,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 256,
        messages: [{ role: "user", content: prompt }],
      }),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { content?: { text?: string }[] }
    const text = data?.content?.[0]?.text ?? ""
    return parseScores(text)
  } finally {
    clearTimeout(timer)
  }
}

async function callOpenAI(model: string, prompt: string, apiKey: string): Promise<number[] | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), RERANK_TIMEOUT_MS)
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      signal: controller.signal,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 256,
        messages: [{ role: "user", content: prompt }],
      }),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    const text = data?.choices?.[0]?.message?.content ?? ""
    return parseScores(text)
  } finally {
    clearTimeout(timer)
  }
}

function parseScores(text: string): number[] | null {
  try {
    // Extract JSON array from text (LLM may include surrounding prose)
    const match = text.match(/\[[\d.,\s"e\-]+\]/i)
    if (!match) return null
    const arr = JSON.parse(match[0])
    if (!Array.isArray(arr)) return null
    return arr.map((v: unknown) => {
      const n = typeof v === "number" ? v : parseFloat(String(v))
      return isNaN(n) ? 0 : Math.max(0, Math.min(1, n))
    })
  } catch {
    return null
  }
}
