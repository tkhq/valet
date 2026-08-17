/**
 * Whether a workflow run has a live person behind it.
 *
 * A `tool` node that touches GitHub must not silently run on one person's
 * personal token when nobody started the work. That token carries their
 * identity, and it stops working the day they leave the team. The GitHub
 * resolver takes a `presence` for this (`services/github-tokens.ts`); this
 * module derives that value from the run row.
 *
 * ── Where the signal comes from ─────────────────────────────────────────
 * There is no column that records "a human was watching". The nearest true
 * fact is the trigger discriminant every start path writes into
 * `RunParams.input` (`WorkflowTriggerPayload.type`). It says which MECHANISM
 * started the run:
 *
 *   - `schedule` / `event` / `webhook` — a machine started it. Unattended.
 *   - `manual` — an authenticated principal asked for it. Attended.
 *   - `workflow` — a `workflow` node in a parent run started it. It
 *     inherits the parent's presence (see below).
 *
 * ── What this signal is NOT ─────────────────────────────────────────────
 * `manual` means "a request arrived from an authenticated principal", not
 * "a person is watching". `workflows.start_run` is an agent-callable action
 * (`workflows/actions.ts`), so an orchestrator that starts a workflow
 * produces a `manual` run with nobody present. Closing that gap needs the
 * calling SESSION's own attendedness, which the session path does not carry
 * today — see the design note in `engine-deps.ts`. Treat `manual` as the
 * conservative reading: it keeps today's behavior rather than moving an
 * identity we cannot prove is unattended.
 *
 * ── Why the links are followed ──────────────────────────────────────────
 * Two start paths stamp a trigger type that describes the START MECHANISM
 * but not the WORK:
 *
 *   - A sub-workflow child is always `workflow`, whatever started the
 *     parent. Reading it as attended would re-open the hole for every
 *     fan-out under a scheduled parent.
 *   - A retry is always `manual`, because a person did click retry. But the
 *     work it re-runs can be a scheduled fire, and a retry that runs as a
 *     different identity than the run it retries tests a different thing
 *     than the one that failed.
 *
 * The two stack. A person retries a scheduled run, and that retry fans out
 * to a sub-workflow child: the child links to the retry, which is `manual`,
 * and the retry links to the scheduled run. One hop reads the retry's bare
 * `manual` and calls the child attended, while the retry itself is
 * unattended — the same fan-out hole this module exists to close. So
 * `resolveRunPresence` walks the links to the first run that has no link.
 *
 * The walk is bounded twice over. `MAX_LINK_HOPS` caps it at the deepest
 * chain the start paths can build (child → retry → original; nesting depth
 * is capped at 1 in `workflow/src/nodes/workflow-call.ts`), and a visited
 * set stops a self-referential or cyclic link. Neither bound can loop.
 */
import type { WorkflowRun, WorkflowStore } from "@valet/workflow";
import type { GitHubActorPresence } from "../services/github-tokens.js";

/** The trigger discriminants `WorkflowTriggerPayload.type` can carry. */
const TRIGGER_TYPES = ["manual", "schedule", "webhook", "event", "workflow"] as const;
export type WorkflowTriggerType = (typeof TRIGGER_TYPES)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * The trigger type inside a stored `RunParams.input`, which is `unknown` at
 * rest. `undefined` when the payload is absent or does not carry a
 * recognized discriminant.
 */
export function triggerTypeOf(input: unknown): WorkflowTriggerType | undefined {
  if (!isRecord(input)) return undefined;
  const type = input.type;
  return TRIGGER_TYPES.find((candidate) => candidate === type);
}

/**
 * Presence for a trigger type read on its own, with no link to follow.
 *
 * An unrecognized type resolves to `"unattended"`. That is the safe way to
 * be wrong: an unattended result prefers the App but still falls back to
 * the user credential, so nothing breaks. An attended result would keep a
 * machine-started run on a personal token, which is the failure this whole
 * module exists to prevent.
 */
export function presenceForTriggerType(type: WorkflowTriggerType | undefined): GitHubActorPresence {
  return type === "manual" ? "attended" : "unattended";
}

/**
 * The deepest chain the start paths can build: a sub-workflow child links to
 * a retry, and that retry links to the run it retries. A chain longer than
 * this cannot occur, so the walk stops rather than reading further.
 */
const MAX_LINK_HOPS = 2;

/**
 * The run this one takes its provenance from, or `undefined` when it is the
 * start of the chain. `parentRunId` only means anything for a `workflow`
 * child; `retryOf` is read for any type because only the retry path sets it.
 */
function linkedRunIdOf(run: WorkflowRun): string | undefined {
  return triggerTypeOf(run.params.input) === "workflow" ? run.params.parentRunId : run.params.retryOf;
}

/**
 * Presence for one run, following its links to the run that started the
 * work.
 *
 * A `workflow` child reads its parent, and a retry reads the run it
 * retries. When a linked run cannot be loaded, or a link points back at a
 * run already read, the result is `"unattended"` — the same safe-direction
 * default `presenceForTriggerType` uses for an unrecognized type.
 */
export async function resolveRunPresence(store: WorkflowStore, run: WorkflowRun): Promise<GitHubActorPresence> {
  let current = run;
  const visited = new Set<string>([run.runId]);

  for (let hop = 0; hop < MAX_LINK_HOPS; hop += 1) {
    const linkedRunId = linkedRunIdOf(current);
    if (linkedRunId === undefined) break;
    // A link back to a run already read is malformed data. Stop on the safe
    // side rather than reading the same rows again.
    if (visited.has(linkedRunId)) return "unattended";
    visited.add(linkedRunId);

    const linked = await store.getRun(linkedRunId);
    if (linked === null) return "unattended";
    current = linked;
  }

  // A run that still carries a link here sits deeper than the start paths
  // can build, so its own trigger type does not say what started the work.
  // Answer in the safe direction instead of reading it.
  if (linkedRunIdOf(current) !== undefined) return "unattended";
  return presenceForTriggerType(triggerTypeOf(current.params.input));
}
