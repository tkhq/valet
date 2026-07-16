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
