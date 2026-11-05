/**
 * The accept-both window for two renames (spec 2026-10-16: presence hub,
 * Part H):
 *
 * - The reply identity `presence` is now `appearance`.
 * - The assistant target's discriminator `kind: "orchestrator"` is now
 *   `kind: "assistant"`, and its scope field `orchestrator` is now
 *   `assistant`.
 *
 * Writes accept both spellings for one release and store the new one.
 * Stored rows are read with both spellings, because no backfill runs. Reads
 * emit only the new names. When the window closes, delete the legacy
 * constants here and the code that reads them.
 */

/** Refusal for a write that names the reply identity twice. */
export const APPEARANCE_CONFLICT = "Send appearance, not presence.";
/** Refusal for a target that names the assistant scope twice. */
export const ASSISTANT_SCOPE_CONFLICT = "Send assistant, not orchestrator.";

/** The old discriminator and scope field name. Read in stored rows and accepted on write. */
export const LEGACY_ASSISTANT_KIND = "orchestrator";
/** The old identity field name. Read in stored rows and accepted on write. */
export const LEGACY_APPEARANCE_FIELD = "presence";

/** True for an assistant target's discriminator, in either spelling. */
export function isAssistantKind(kind: unknown): boolean {
  return kind === "assistant" || kind === LEGACY_ASSISTANT_KIND;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An assistant target's scope (`user`, `team`, `org`), read from either field name. */
export function assistantScopeOf(target: unknown): unknown {
  if (!isRecord(target)) return undefined;
  return target.assistant !== undefined ? target.assistant : target[LEGACY_ASSISTANT_KIND];
}

/** The reply identity on a target or a request body, read from either field name. */
export function appearanceOf(record: unknown): unknown {
  if (!isRecord(record)) return undefined;
  return record.appearance !== undefined ? record.appearance : record[LEGACY_APPEARANCE_FIELD];
}

/**
 * The identity a write sends, from either field name. A body that sends both
 * is refused. `undefined` means the write leaves the identity alone; `null`
 * clears it.
 */
export function acceptAppearanceWrite(body: { appearance?: unknown; presence?: unknown }): { ok: true; appearance: unknown } | { ok: false; error: string } {
  if (body.appearance !== undefined && body.presence !== undefined) return { ok: false, error: APPEARANCE_CONFLICT };
  return { ok: true, appearance: body.appearance !== undefined ? body.appearance : body.presence };
}

function rename(target: Record<string, unknown>): Record<string, unknown> {
  const { [LEGACY_APPEARANCE_FIELD]: legacyAppearance, [LEGACY_ASSISTANT_KIND]: legacyScope, ...rest } = target;
  const next: Record<string, unknown> = { ...rest };
  if (next.kind === LEGACY_ASSISTANT_KIND) next.kind = "assistant";
  // The new name wins when a stored row somehow carries both.
  if (next.appearance === undefined && legacyAppearance !== undefined) next.appearance = legacyAppearance;
  if (next.kind === "assistant" && next.assistant === undefined && legacyScope !== undefined) next.assistant = legacyScope;
  return next;
}

/**
 * A request target with the new names. A target that sends both names for
 * one field is refused. A value that is not an object passes through, so the
 * write validator reports it.
 */
export function acceptTargetWrite(target: unknown): { ok: true; target: unknown } | { ok: false; error: string } {
  if (!isRecord(target)) return { ok: true, target };
  if (target.appearance !== undefined && target[LEGACY_APPEARANCE_FIELD] !== undefined) return { ok: false, error: APPEARANCE_CONFLICT };
  if (target.assistant !== undefined && target[LEGACY_ASSISTANT_KIND] !== undefined) return { ok: false, error: ASSISTANT_SCOPE_CONFLICT };
  return { ok: true, target: rename(target) };
}

/** A stored target with the new names. Old rows keep their old names on disk until a write touches them. */
export function readStoredTarget(target: unknown): unknown {
  return isRecord(target) ? rename(target) : target;
}

/** A schedule's stored `target_kind`, with the old `orchestrator` value read as `assistant`. */
export function readScheduleTargetKind(kind: string): "workflow" | "assistant" {
  return isAssistantKind(kind) ? "assistant" : "workflow";
}
