/**
 * Reasoning (thinking) level vocabulary for the engine.
 *
 * A reasoning level tells the provider how much thinking effort to spend on
 * a turn. pi-ai maps the level per provider (OpenAI reasoning_effort,
 * Anthropic thinking budgets, OpenRouter reasoning.effort, ...).
 *
 * The engine owns this vocabulary itself. It must not import the api
 * package's copy: the engine is portable, and its barrel must stay
 * browser-safe (no node builtins in the index chain).
 *
 * Two rules shape the code here:
 *
 * 1. The clamp runs at STREAM time, not at set time. A thread pinned to
 *    "max" keeps the pin while it runs a model that tops out at "high";
 *    switch the thread back to a capable model and the original pin
 *    applies again. Clamping at set time would silently rewrite the user's
 *    choice against whichever model happened to be active.
 * 2. A persisted token that this build does not recognize resolves to
 *    `undefined` instead of throwing. A restore must never die on one bad
 *    column value.
 */
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai/compat";

/** The six reasoning levels, in ascending order of effort. */
export const REASONING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** One of the six reasoning levels. Structurally pi-ai's `ThinkingLevel`. */
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

const REASONING_SET: ReadonlySet<string> = new Set<string>(REASONING_LEVELS);

/** True when `value` is one of the six levels. */
export function isReasoningLevel(value: unknown): value is ReasoningLevel {
  return typeof value === "string" && REASONING_SET.has(value);
}

/**
 * Read a persisted reasoning token. An absent, null, or unrecognized value
 * resolves to `undefined` (provider default) rather than throwing.
 */
export function parseReasoningLevel(value: string | null | undefined): ReasoningLevel | undefined {
  return isReasoningLevel(value) ? value : undefined;
}

/**
 * Effective reasoning level for one stream call: per-call option → thread
 * pin → session default, clamped to what `model` supports.
 *
 * Returns `undefined` when no layer sets a level, or when the model has no
 * reasoning support at all (pi-ai clamps to "off" there, and
 * `StreamOptions.reasoning` has no "off" — sending nothing leaves the
 * provider default in place).
 */
export function resolveReasoningLevel(
  model: Model<Api>,
  perCall: ThinkingLevel | undefined,
  threadPin: ReasoningLevel | undefined,
  sessionDefault: ThinkingLevel | undefined,
): ThinkingLevel | undefined {
  const requested = perCall ?? threadPin ?? sessionDefault;
  if (requested === undefined) return undefined;
  const clamped = clampThinkingLevel(model, requested);
  return clamped === "off" ? undefined : clamped;
}
