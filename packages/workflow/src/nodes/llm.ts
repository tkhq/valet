/**
 * `llm` node executor (node-completion plan decision 4). A single,
 * non-durable completion over `engine.llmComplete` — never parks, always
 * completes or fails within one `driveUntilPark` call.
 *
 * Determinism / at-least-once dispatch:
 *   - Unlike `session`/`orchestrator`, `llmComplete` has no receiver-side
 *     idempotency handle (no `dispatchId` to dedupe against) — the engine
 *     contract (`engine-deps.ts`) is explicit that this is at-least-once:
 *     the intent checkpoint narrows the duplicate window, and one duplicate
 *     billed call on a crash-after-dispatch-before-checkpoint is the
 *     accepted cost.
 *   - The intent checkpoint needs no effects on first entry (no id to
 *     remember). If the model's response fails `outputSchema` validation,
 *     exactly one repair round is attempted; that decision — and the first
 *     failure's validation error, so a resume can rebuild the exact same
 *     repair prompt without re-running the original call — is persisted
 *     into `effects` before the repair call, mirroring `session`'s
 *     `repairAttempted` bookkeeping.
 *
 * Lifecycle:
 *   1. No prior checkpoint: write the (effects-less) intent.
 *   2. `effects.repairAttempted` not set (first entry, or resumed after a
 *      crash before the repair decision was persisted): render `prompt`/
 *      `system` over the template context, call `llmComplete` (clamped
 *      `maxOutputTokens`). A throw fails the node with the error message.
 *      No `outputSchema`, or `outputSchema` set and the response validates
 *      → node `completed` with `{ text, output? }` (size-guarded). Schema
 *      set and validation fails → persist `{ repairAttempted: true,
 *      firstError }` into effects (equal-attempt overwrite) and fall
 *      through to the repair call in the same drive (no park).
 *   3. `effects.repairAttempted` already set (freshly, or resumed after a
 *      crash before the repair call's result was checkpointed): re-render
 *      the repair prompt from the persisted `firstError` and call
 *      `llmComplete` again. Valid → completed; invalid or throw → node
 *      `failed`.
 *   4. Before any `completed` write, the result JSON is size-guarded
 *      (512KB) — oversized fails the node instead.
 */

import { extractStructuredOutput } from '@valet/engine';

import { renderTemplate, type TemplateContext } from '../dag/expression.js';
import type { LlmNode } from '../dag/nodes.js';
import type { NodeCheckpoint } from '../store.js';
import { resolveTemplateContext, type NodeExecuteResult, type NodeExecutorArgs } from './index.js';

const MAX_OUTPUT_TOKENS_CEILING = 16_384;
const MAX_RESULT_BYTES = 512 * 1024;

export interface LlmResult {
  text: string;
  output?: unknown;
}

interface LlmEffects {
  repairAttempted: boolean;
  firstError?: string;
}

export async function executeLlm(args: NodeExecutorArgs<LlmNode>): Promise<NodeExecuteResult> {
  const { run, node, attempt, iteration, store, clock, engine, existingCheckpoint } = args;
  const templateContext = resolveTemplateContext(args);

  let effects = readEffects(existingCheckpoint);

  if (existingCheckpoint === undefined) {
    await store.putIntent({
      runId: run.runId,
      nodeId: node.id,
      iteration,
      status: 'intent',
      attempt,
      createdAt: clock(),
      effects: effectsToRecord(effects),
    });
  }

  const promptText = renderText(node.prompt, templateContext);
  const systemText = node.system !== undefined ? renderText(node.system, templateContext) : undefined;
  const maxOutputTokens = clampMaxOutputTokens(node.maxOutputTokens);

  if (!effects.repairAttempted) {
    let completion;
    try {
      completion = await engine.llmComplete({
        model: node.model,
        system: systemText,
        prompt: promptText,
        temperature: node.temperature,
        maxOutputTokens,
      });
    } catch (err) {
      return await fail(args, effects, errorMessage(err));
    }

    if (node.outputSchema === undefined) {
      return await complete(args, effects, { text: completion.text });
    }

    const extracted = extractStructuredOutput(completion.text, node.outputSchema);
    if (extracted.output !== undefined) {
      return await complete(args, effects, { text: completion.text, output: extracted.output });
    }

    // Schema validation failed: persist the repair decision (+ the
    // validation error a resume would otherwise lose) before issuing the
    // repair call, then fall through to it in this same drive.
    effects = { repairAttempted: true, firstError: extracted.error };
    await store.putIntent({
      runId: run.runId,
      nodeId: node.id,
      iteration,
      status: 'intent',
      attempt,
      createdAt: clock(),
      effects: effectsToRecord(effects),
    });
  }

  const schema = node.outputSchema;
  if (schema === undefined) {
    // Contract violation: repair is only ever entered when outputSchema is
    // set (the definition never changes across drives), so this is
    // unreachable in practice — a defensive guard, not a real branch.
    return await fail(args, effects, `llm node "${node.id}" entered repair with no outputSchema — contract violation`);
  }

  const repairPrompt = buildRepairPrompt(promptText, schema, effects.firstError);
  let repairCompletion;
  try {
    repairCompletion = await engine.llmComplete({
      model: node.model,
      system: systemText,
      prompt: repairPrompt,
      temperature: node.temperature,
      maxOutputTokens,
    });
  } catch (err) {
    return await fail(args, effects, errorMessage(err));
  }

  const repairExtracted = extractStructuredOutput(repairCompletion.text, schema);
  if (repairExtracted.output !== undefined) {
    return await complete(args, effects, { text: repairCompletion.text, output: repairExtracted.output });
  }

  const error = repairExtracted.error ?? `llm node "${node.id}" result did not match outputSchema after repair`;
  return await fail(args, effects, error);
}

async function complete(args: NodeExecutorArgs<LlmNode>, effects: LlmEffects, result: LlmResult): Promise<NodeExecuteResult> {
  const { run, node, attempt, iteration, store, clock } = args;

  const bytes = new TextEncoder().encode(JSON.stringify(result)).length;
  if (bytes > MAX_RESULT_BYTES) {
    return await fail(args, effects, `llm node "${node.id}" result exceeds ${MAX_RESULT_BYTES} bytes (${bytes} bytes)`);
  }

  await store.completeCheckpoint(run.runId, node.id, iteration, attempt, {
    runId: run.runId,
    nodeId: node.id,
    iteration,
    status: 'completed',
    result,
    effects: effectsToRecord(effects),
    attempt,
    createdAt: clock(),
  });
  return { status: 'completed', result };
}

async function fail(args: NodeExecutorArgs<LlmNode>, effects: LlmEffects, error: string): Promise<NodeExecuteResult> {
  const { run, node, attempt, iteration, store, clock } = args;
  await store.completeCheckpoint(run.runId, node.id, iteration, attempt, {
    runId: run.runId,
    nodeId: node.id,
    iteration,
    status: 'failed',
    error,
    effects: effectsToRecord(effects),
    attempt,
    createdAt: clock(),
  });
  return { status: 'failed', error };
}

function buildRepairPrompt(originalPrompt: string, schema: Record<string, unknown>, validationError: string | undefined): string {
  const errorText = validationError ?? 'result did not match the schema';
  return `${originalPrompt}\n\nYour previous response failed validation: ${errorText}\nRespond with ONLY JSON matching this schema:\n${JSON.stringify(schema)}`;
}

function clampMaxOutputTokens(requested: number | undefined): number | undefined {
  if (requested === undefined) return undefined;
  return Math.min(requested, MAX_OUTPUT_TOKENS_CEILING);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readEffects(existingCheckpoint: NodeCheckpoint | undefined): LlmEffects {
  const raw = existingCheckpoint?.effects;
  if (!raw) return { repairAttempted: false };
  return {
    repairAttempted: raw.repairAttempted === true,
    firstError: typeof raw.firstError === 'string' ? raw.firstError : undefined,
  };
}

function effectsToRecord(effects: LlmEffects): Record<string, unknown> {
  const record: Record<string, unknown> = { repairAttempted: effects.repairAttempted };
  if (effects.firstError !== undefined) record.firstError = effects.firstError;
  return record;
}

function renderText(source: string, ctx: TemplateContext): string {
  const v = renderTemplate(source, ctx);
  if (typeof v === 'string') return v;
  if (v === undefined || v === null) return '';
  return JSON.stringify(v);
}
