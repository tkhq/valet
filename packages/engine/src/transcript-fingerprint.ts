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

/** Last lines kept on a span attribute. Stop-reason drift is at the tail. */
export const FINGERPRINT_SPAN_MAX_LINES = 64;
/** Byte cap for a span fingerprint attribute, including the count= header. */
export const FINGERPRINT_SPAN_MAX_BYTES = 8192;

function readPiAiVersion(): string {
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

/** Installed pi-ai version, read once at module load. */
export const piAiVersion = readPiAiVersion();

/**
 * Prefix `count=` and keep the last lines that fit the line and byte caps.
 * Span attributes drop the head of a long transcript; the tail carries
 * the stop-reason lines that distinguish a live thread from a rebuild.
 */
export function boundFingerprint(
  fp: string,
  opts?: { maxBytes?: number; maxLines?: number },
): string {
  const maxBytes = opts?.maxBytes ?? FINGERPRINT_SPAN_MAX_BYTES;
  const maxLines = opts?.maxLines ?? FINGERPRINT_SPAN_MAX_LINES;
  const lines = fp.length === 0 ? [] : fp.split("\n");
  const header = `count=${lines.length}`;
  if (lines.length === 0) return header;

  const tail = lines.slice(-maxLines);
  const kept: string[] = [];
  let size = header.length + 1;
  for (let i = tail.length - 1; i >= 0; i--) {
    const line = tail[i]!;
    const add = line.length + 1;
    if (kept.length > 0 && size + add > maxBytes) break;
    if (kept.length === 0 && size + add > maxBytes) {
      const room = maxBytes - size;
      if (room > 0) kept.push(line.slice(-room));
      break;
    }
    kept.push(line);
    size += add;
  }
  kept.reverse();
  return [header, ...kept].join("\n");
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
      const content = "content" in m ? m.content : undefined;
      return `${role} ${stop} ${api} ${provider} ${model} ${blockKinds(content)}`;
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
