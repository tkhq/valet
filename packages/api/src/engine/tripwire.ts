/**
 * Credential tripwire (Part 10 §Redaction). Scans outbound WS frames for a
 * byte substring matching a live credential value or one of its encoded
 * forms. A hit redacts the bytes in place, records a `security_incidents`
 * row, and logs a warning. v1 does NOT hard-fail the cell — that requires
 * engine-level coordination and lands in a follow-up. The invariant
 * `value never leaves the api process on the wire` is preserved either way.
 *
 * The scanner runs only on wire frames that carry potentially-sensitive
 * bytes: `tool_start.args`, `tool_end.result`, `message_update.content`,
 * and `text_delta.delta`. Every other frame kind is skipped for speed.
 */
import type { WireEventDraft } from "./bridge.js";
import type {
  EngagementVault,
  TripwireIndexSnapshot,
} from "../services/security-vault.js";

export const REDACTED_MARKER = "[REDACTED cred:";

/** Scan a wire frame in place and record any tripwire hit. Returns the
 * list of credential labels that hit (empty when clean). */
export function scanAndRedactWireEvent(
  draft: WireEventDraft,
  index: TripwireIndexSnapshot,
): string[] {
  if (index.entries.length === 0) return [];
  const hits: string[] = [];
  const mut = draft as unknown as Record<string, unknown>;
  switch (draft.type) {
    case "tool_start": {
      const before = safeStringify(mut.args);
      const after = redactString(before, index, hits);
      if (after !== before) mut.args = tryReparse(after);
      break;
    }
    case "tool_end": {
      const before = safeStringify(mut.result);
      const after = redactString(before, index, hits);
      if (after !== before) mut.result = tryReparse(after);
      break;
    }
    case "message_update": {
      const content = mut.content;
      if (typeof content === "string") {
        const after = redactString(content, index, hits);
        if (after !== content) mut.content = after;
      }
      const parts = mut.parts;
      if (Array.isArray(parts)) {
        for (const p of parts) {
          const part = p as { kind?: string; text?: string };
          if (part.kind === "text" && typeof part.text === "string") {
            const after = redactString(part.text, index, hits);
            if (after !== part.text) part.text = after;
          }
        }
      }
      break;
    }
    case "text_delta": {
      const delta = typeof mut.delta === "string" ? mut.delta : "";
      const after = redactString(delta, index, hits);
      if (after !== delta) mut.delta = after;
      break;
    }
    default:
      // All other frame kinds carry only metadata (ids, statuses, offsets).
      return [];
  }
  return hits;
}

/** Byte-substring scan of `haystack` against every match buffer in the
 * index. When a hit is found, replace the byte substring with a marker
 * `[REDACTED cred:<label>]` and push the label into `hits`. */
function redactString(
  haystack: string,
  index: TripwireIndexSnapshot,
  hits: string[],
): string {
  let out = haystack;
  for (const entry of index.entries) {
    for (const match of entry.matchBytes) {
      const needle = match.toString("utf8");
      if (needle.length < 8) continue;
      if (out.includes(needle)) {
        // Replace ALL occurrences with the redaction marker.
        const marker = `${REDACTED_MARKER}${entry.label}]`;
        out = out.split(needle).join(marker);
        hits.push(entry.label);
      }
    }
  }
  return out;
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function tryReparse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Record a batch of tripwire hits into `security_incidents`. Called by the
 * WS route after `scanAndRedactWireEvent` returns a non-empty list. */
export async function recordTripwireHits(
  vault: EngagementVault,
  ctx: { engagementId: string; cellId?: string | null; quarantinedEntryId?: string | null },
  index: TripwireIndexSnapshot,
  labels: string[],
): Promise<void> {
  const uniqueLabels = Array.from(new Set(labels));
  for (const label of uniqueLabels) {
    const entry = index.entries.find((e) => e.label === label);
    await vault.recordIncident({
      engagementId: ctx.engagementId,
      cellId: ctx.cellId ?? null,
      credentialId: entry?.credentialId ?? null,
      credentialLabel: label,
      seam: "send",
      quarantinedEntryId: ctx.quarantinedEntryId ?? null,
    });
  }
}
