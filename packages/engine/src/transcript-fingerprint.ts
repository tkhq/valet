/**
 * Compact transcript fingerprint for the split-brain diagnostic (TKAI-220).
 * One line per message: role, stop reason, api, provider, model, block kinds.
 * No message content. Gate stdout on VALET_TRANSCRIPT_DEBUG=1.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "./types.js";

/** Installed pi-ai version, read from this package's pinned dependency. */
export function piAiVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const pinned = pkg.dependencies?.["@earendil-works/pi-ai"];
    if (typeof pinned === "string" && pinned.length > 0) {
      return pinned.replace(/^[^\d]*/, "");
    }
  } catch {
    /* fall through */
  }
  return "unknown";
}

function blockKinds(content: unknown): string {
  if (!Array.isArray(content)) return "-";
  const kinds = content
    .map((block) =>
      block && typeof block === "object" && "type" in block && typeof block.type === "string"
        ? block.type
        : "?",
    )
    .join(",");
  return kinds.length > 0 ? kinds : "-";
}

function dash(value: string | undefined): string {
  return value && value.length > 0 ? value : "-";
}

/** One compact line per agent message, in order. */
export function fingerprintMessages(messages: readonly AgentMessage[]): string {
  return messages
    .map((m) => {
      const role = m.role === "assistant" ? "a" : m.role === "user" ? "u" : m.role === "toolResult" ? "t" : "s";
      const stop = m.role === "assistant" ? dash(m.stopReason) : "-";
      const api = m.role === "assistant" ? dash(m.api) : "-";
      const provider = m.role === "assistant" ? dash(m.provider) : "-";
      const model = m.role === "assistant" ? dash(m.model) : "-";
      return `${role} ${stop} ${api} ${provider} ${model} ${blockKinds(m.content)}`;
    })
    .join("\n");
}

/** One compact line per persisted message entry, in order. */
export function fingerprintEntries(entries: readonly SessionEntry[]): string {
  return entries
    .filter((e): e is Extract<SessionEntry, { type: "message" }> => e.type === "message")
    .map((e) => {
      const role = e.role === "assistant" ? "a" : e.role === "user" ? "u" : e.role === "tool" ? "t" : "s";
      const stop = e.role === "assistant" ? dash(e.stopReason) : "-";
      const kinds =
        e.parts && e.parts.length > 0
          ? e.parts
              .map((p) => (p.type === "tool_call" ? "toolCall" : p.type))
              .join(",")
          : e.content
            ? "text"
            : "-";
      return `${role} ${stop} - - ${dash(e.model)} ${kinds}`;
    })
    .join("\n");
}

export type TranscriptFingerprintSource = "rehydrate" | "resume" | "compaction" | "send";
