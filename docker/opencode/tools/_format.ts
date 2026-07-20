import { encode } from "@toon-format/toon"

/** Encode data as TOON for token-efficient LLM output. Falls back to JSON on error. */
export function formatOutput(data: unknown): string {
  try {
    return encode(data)
  } catch {
    return JSON.stringify(data, null, 2)
  }
}

/**
 * Build the note appended to a truncated page of session messages.
 *
 * Which messages are hidden depends on how the page was taken. A default read returns
 * the newest window, so what is missing sits EARLIER in the conversation and is reached
 * by asking for a larger window. A read that passed an `after` cursor returns the window
 * starting at that cursor, so what is missing is NEWER and is reached by paging forward
 * from the last message shown. Telling the reader to look the wrong way costs it a whole
 * round-trip, so the two cases get different wording.
 */
export function paginationHint(shown: number, mode: "recent" | "after"): string {
  if (mode === "after") {
    return (
      `[${shown} messages shown from the cursor — newer messages exist. ` +
      `Call again with 'after' set to the createdAt of the last message above to keep paging forward.]`
    )
  }
  return (
    `[${shown} most recent messages shown — earlier messages exist. ` +
    `Call again with a higher 'limit' if you need more of the conversation history.]`
  )
}

/**
 * Drop tool-call `result` payloads from a list of messages before encoding.
 *
 * When one agent reads another session's messages it needs the child's assistant
 * text (and the tool names/args are useful context), but not the child's full
 * tool-result dumps — those can be huge and crowd out the text the reader is after.
 * Tool names, args, and status are preserved; only the result payload is removed.
 * Non-tool parts and messages without parts pass through untouched.
 */
export function stripToolResults<T extends Record<string, unknown>>(messages: T[]): T[] {
  return messages.map((message) => {
    const parts = message.parts
    if (!Array.isArray(parts)) return message
    let mutated = false
    const shaped = parts.map((part) => {
      if (
        part &&
        typeof part === "object" &&
        (part as Record<string, unknown>).type === "tool-call" &&
        "result" in (part as Record<string, unknown>)
      ) {
        mutated = true
        const { result, ...rest } = part as Record<string, unknown>
        void result
        return rest
      }
      return part
    })
    return mutated ? { ...message, parts: shaped } : message
  })
}
