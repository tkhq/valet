/**
 * Persist-seam tripwire hook (Part 10 §Redaction).
 *
 * A `beforeEntryPersist` callback wired into every security persona child
 * session's `SessionOptions`. Scans the entry's `parts` and `content`
 * bytes for a substring match against the engagement's live credential
 * fingerprint index. On a hit: redact the bytes in place to
 * `[REDACTED cred:<label>]` and enqueue a `security_incidents` row.
 *
 * The scanner is lazy: the tripwire index for the persona child's owning
 * engagement is loaded on the first entry-persist and cached for the hook
 * closure's lifetime. A new credential written to the vault after that
 * point misses this hook until the next persona child spawns; that
 * boundary is acceptable for v1 because a new credential mid-cell is
 * either a resume (fresh cell → fresh hook) or an operator patching a
 * live run (rare, and the send seam still redacts on the WS).
 */
import type { AppDb } from "../lib/drizzle.js";
import type { BeforeEntryPersist, MessagePart, SessionEntry } from "@valet/engine";
import { REDACTED_MARKER } from "./tripwire.js";
import {
  createEngagementVault,
  type EngagementVault,
  type TripwireIndexSnapshot,
} from "../services/security-vault.js";

export interface PersistTripwireDeps {
  db: AppDb;
  key: Buffer;
  kekId: string;
  engagementId: string;
  cellId: string | null;
}

/**
 * Build the hook. The `dispose()` handle zeros the cached index Buffers
 * and MUST be called when the session's lifetime ends (`buildChildSession`
 * disposes on error paths + when the child finishes).
 */
export function buildPersistTripwire(deps: PersistTripwireDeps): {
  hook: BeforeEntryPersist;
  dispose: () => void;
} {
  let indexPromise: Promise<TripwireIndexSnapshot | null> | null = null;
  let vault: EngagementVault | null = null;

  const loadIndex = async (): Promise<TripwireIndexSnapshot | null> => {
    if (indexPromise) return indexPromise;
    indexPromise = (async () => {
      vault = createEngagementVault({
        db: deps.db,
        key: deps.key,
        kekId: deps.kekId,
      });
      const snap = await vault.tripwireIndex(deps.engagementId);
      return snap.entries.length > 0 ? snap : null;
    })();
    return indexPromise;
  };

  const hook: BeforeEntryPersist = async (entry) => {
    const index = await loadIndex();
    if (!index) return entry;
    const hits: string[] = [];
    const redacted = redactEntry(entry, index, hits);
    if (hits.length > 0 && vault) {
      const uniqueLabels = Array.from(new Set(hits));
      for (const label of uniqueLabels) {
        const info = index.entries.find((e) => e.label === label);
        // Fire-and-forget: incident recording must not block persist.
        void vault
          .recordIncident({
            engagementId: deps.engagementId,
            cellId: deps.cellId,
            credentialId: info?.credentialId ?? null,
            credentialLabel: label,
            seam: "persist",
            quarantinedEntryId: entry.id,
          })
          .catch((err) => {
            console.error("persist tripwire: recordIncident failed:", err);
          });
      }
    }
    return redacted;
  };

  return {
    hook,
    dispose: () => {
      // Await was intentional-avoid — dispose is void; the snapshot's own
      // dispose zeros the buffers when it lands.
      indexPromise?.then((snap) => snap?.dispose()).catch(() => {});
      indexPromise = null;
      vault = null;
    },
  };
}

/** Scan and redact a `SessionEntry` in place. Returns a NEW entry when
 * bytes changed; otherwise the original. Non-message entries and
 * shape-only entries are returned untouched. */
function redactEntry(
  entry: SessionEntry,
  index: TripwireIndexSnapshot,
  hits: string[],
): SessionEntry {
  // Non-message entries (compaction summaries, gate rows, decision rows)
  // do not carry credential-shaped bytes today; skip the scan.
  const maybeRole = (entry as { role?: string }).role;
  if (maybeRole === undefined) return entry;
  // Assistant messages: `parts` carries tool_call args + tool_result body.
  // User messages: `parts` carries text + attachments.
  const parts = (entry as { parts?: MessagePart[] }).parts;
  if (!parts || parts.length === 0) return entry;

  let changed = false;
  const newParts: MessagePart[] = [];
  for (const part of parts) {
    const p = part as MessagePart & { text?: string; args?: unknown; result?: unknown };
    if (p.type === "text" && typeof p.text === "string") {
      const after = redactString(p.text, index, hits);
      if (after !== p.text) {
        changed = true;
        newParts.push({ ...p, text: after } as MessagePart);
        continue;
      }
    }
    if (p.type === "tool_call") {
      const beforeArgs = safeStringify(p.args);
      const afterArgs = redactString(beforeArgs, index, hits);
      const beforeResult = safeStringify(p.result);
      const afterResult = redactString(beforeResult, index, hits);
      if (afterArgs !== beforeArgs || afterResult !== beforeResult) {
        changed = true;
        newParts.push({
          ...p,
          ...(afterArgs !== beforeArgs ? { args: tryReparse(afterArgs) } : {}),
          ...(afterResult !== beforeResult ? { result: tryReparse(afterResult) } : {}),
        } as MessagePart);
        continue;
      }
    }
    newParts.push(part);
  }

  const content = (entry as { content?: string }).content;
  let newContent = content;
  if (typeof content === "string") {
    const after = redactString(content, index, hits);
    if (after !== content) {
      changed = true;
      newContent = after;
    }
  }

  if (!changed) return entry;
  return {
    ...entry,
    parts: newParts,
    ...(typeof newContent === "string" ? { content: newContent } : {}),
  } as SessionEntry;
}

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
  if (value === undefined || value === null) return "";
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
