/**
 * Agent-facing workflow actions (spec:
 * docs/specs/2026-07-31-workflow-chat-rendering-design.md). Exposed through
 * the plugin catalog (`list_tools`/`call_tool`) so the orchestrator can
 * create, inspect, and run dag/v1 workflows conversationally. Every result
 * carries the ids (`workflowId`/`runId`) the web chat renderer fetches by.
 */
import {
  encodeToolOutput,
  type ActionPlugin,
  type PluginAction,
  type PluginActionContext,
  type PluginActionResult,
} from "@valet/engine";
import { TeamAdminRequiredError } from "../services/team-deletion-access.js";
import { submitDeletionRequest } from "../services/team-deletion-requests.js";
import { proposalResult } from "../events/proposals.js";
import { ValetError } from "@valet/shared";
import { WorkflowCursorError, type WorkflowDefinition, type WorkflowEdge, type WorkflowRun } from "@valet/workflow";
import type { Static, TSchema } from "typebox";
import { Type } from "typebox";
import { buildOrgCatalog, catalogValidIds } from "../services/model-catalog.js";
import { previewWorkflow } from "../routes/workflow-preview.js";
import type { GetWorkflowPermissionsResponse, PreviewWorkflowResponse, WorkflowPendingGate } from "../wire/types.js";
import {
  appendRemovedEdgeHint,
  applyWorkflowModelPatch,
  applyWorkflowPatch,
  type WorkflowEdgeRef,
} from "./patch.js";
import {
  createWorkflowSchedule,
  deleteWorkflowSchedule,
  listWorkflowSchedules,
  updateWorkflowSchedule,
} from "./schedule-service.js";
import {
  addAggregateNode,
  canReadWorkflowRun,
  cancelWorkflowRun,
  retryWorkflowRun,
  copyWorkflowDefinition,
  createWorkflowDefinition,
  deleteWorkflowDefinition,
  findNodeInDefinition,
  getWorkflowDefinition,
  getWorkflowRunDetail,
  isRunStatus,
  listRunsForOwner,
  listWorkflowDefinitions,
  resolveWorkflowApproval,
  RUN_STATUS_VALUES,
  startWorkflowRun,
  workflowActionOrigin,
  updateWorkflowDefinition,
  validateDefinitionInput,
  type WorkflowOwner,
  type WorkflowServiceDeps,
} from "./service.js";
import type { TeamServiceReadinessDeps } from "./team-service-readiness.js";
import {
  createWorkflowTrigger,
  deleteWorkflowTrigger,
  listEventTypes,
  listWorkflowTriggers,
  updateWorkflowTrigger,
} from "./trigger-service.js";
import { buildOrgValidateEnvironment, buildValidateEnvironment } from "./validation-env.js";
import { allowWorkflowPermissions, analyzeDefinitionPermissions, analyzeWorkflowPermissions, canGrantWorkflowPermissions, needsGrant } from "./permissions.js";
import { readNodeDiagnostics } from "./node-diagnostics.js";
import { readRunFollowUp } from "./run-follow-up.js";
import { readStepTranscript } from "./step-transcript.js";
import { workflowRunProvenance } from "./run-provenance.js";
import {
  deleteWorkflowWebhook,
  getWorkflowWebhook,
  mintOrRotateWorkflowWebhook,
  workflowWebhookUrl,
} from "./webhook-service.js";

/** Cap + bullet the validator's lint output for the LLM. The validator can
 * emit dozens of errors on a badly-shaped definition; the first ~20 are
 * plenty to act on and keep the tool result readable. */
export function formatLintErrors(errors: string[], cap = 20): string {
  const shown = errors.slice(0, cap).map((e) => `- ${e}`);
  const more = errors.length > cap ? `\n… and ${errors.length - cap} more` : "";
  return `workflow definition failed validation (fix these and retry):\n${shown.join("\n")}${more}`;
}

/** One sentence naming what to do about an error the caller did not cause. */
const PRE_EXISTING_ADVICE =
  "The workflow already held the error(s) below before this edit, so this edit did not cause them. " +
  "Fix them in the same call, or open the workflow in the editor and correct them first.";

/**
 * The clauses the validator appends to a message as advice, and the edge
 * index it puts in front of one. Both move when a DIFFERENT part of the
 * definition changes — see `findingKey`.
 */
const HINT_MARKERS = [" — ", " (available:", " (did you mean "];
const EDGE_INDEX = /^edge\[\d+\]/;

/**
 * An identity for one validator finding that holds across two validation
 * runs of two different definitions.
 *
 * The validator builds its advice from the WHOLE definition: the near-match
 * suggestion reads every node id, the "available roots" list reads every
 * alias root, and an edge carries its index in the edge array. An edit to
 * one node therefore rewrites the message of a finding in a different node
 * that the edit never touched. A raw string compare reads the rewritten text
 * as a new finding and tells the caller it caused an error that was already
 * there — the exact mistake this file exists to prevent. So cut the message
 * at the first advice clause and drop the edge index.
 *
 * The key is coarse on purpose. If two findings collapse onto one key, the
 * second one reads as pre-existing. That is the safe direction: the reply
 * still lists the finding in full and still refuses the edit.
 */
export function findingKey(message: string): string {
  let head = message;
  for (const marker of HINT_MARKERS) {
    const at = head.indexOf(marker);
    if (at !== -1) head = head.slice(0, at);
  }
  return head.replace(EDGE_INDEX, "edge");
}

/**
 * Format the lint output of an edit that does NOT re-send the whole
 * definition, such as a patch or an appended node. Such an edit revalidates
 * the merged whole, so an error in a node the caller never touched blocks it.
 * Without the split below the caller reads a stale trigger path in some other
 * node as its own mistake, and retries the same edit until it gives up.
 *
 * @param blocking every error that blocks the edit.
 * @param preExisting the errors the stored definition already carried.
 */
export function formatEditLintErrors(blocking: string[], preExisting: string[], cap = 20): string {
  const carried = new Set(preExisting.map(findingKey));
  const introduced = blocking.filter((e) => !carried.has(findingKey(e)));
  const inherited = blocking.filter((e) => carried.has(findingKey(e)));
  if (inherited.length === 0) return formatLintErrors(blocking, cap);

  const bullets = (list: string[]): string => {
    const shown = list.slice(0, cap).map((e) => `- ${e}`);
    const more = list.length > cap ? `\n… and ${list.length - cap} more` : "";
    return `${shown.join("\n")}${more}`;
  };
  const inheritedBlock = `${PRE_EXISTING_ADVICE}\n${bullets(inherited)}`;
  if (introduced.length === 0) {
    return `workflow definition failed validation (fix these and retry):\n${inheritedBlock}`;
  }
  return (
    `workflow definition failed validation (fix these and retry):\n` +
    `${bullets(introduced)}\n\n${inheritedBlock}`
  );
}

/**
 * The workflow owner for an assistant tool call. The assistant is an agent
 * (`WorkflowOwner.agentEditor`): a step change it makes revokes the
 * workflow's grants.
 */
export function ownerFromContext(ctx: PluginActionContext): WorkflowOwner | null {
  const owner = ownerFromContextUnmarked(ctx);
  return owner ? { ...owner, agentEditor: true } : null;
}

/** The turn is this person's own signed-in prompt: never an event, a signal,
 * a workflow step or delegated work (`ToolContext.interactiveActor`). */
function isDirectActor(ctx: PluginActionContext, owner: WorkflowOwner): boolean {
  return ctx.interactiveActor?.id === owner.userId && !ctx.externalSender
    && ctx.sessionPurpose !== "workflow" && ctx.sessionPurpose !== "child";
}

/** Rules a person cannot override from a workflow's review. */
const POLICY_HELD = new Set(["org_policy", "team_policy", "override"]);

/** Text on one line, control characters removed, cut to `max` characters. */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** A tool step's stored parameters: a top-level tool node, or a foreach's tool body. */
function stepParams(definition: unknown, nodeId: string): unknown {
  const nodes = definition && typeof definition === "object" ? (definition as { nodes?: unknown }).nodes : undefined;
  if (!Array.isArray(nodes)) return undefined;
  const node: unknown = nodes.find((item: unknown) => !!item && typeof item === "object" && (item as { id?: unknown }).id === nodeId);
  if (!node || typeof node !== "object") return undefined;
  const record = node as Record<string, unknown>;
  const tool = record.type === "foreach" && record.body && typeof record.body === "object" ? record.body as Record<string, unknown> : record;
  return tool.params;
}

/** The distinct actions a workflow's steps wait on for approval. */
function gatingActionIds(review: GetWorkflowPermissionsResponse): string[] {
  return [...new Set(review.nodes.flatMap((node) => needsGrant(node) && node.actionId ? [node.actionId] : []))];
}

/** What a saved workflow still needs a person to allow, for a save result. */
async function approvalNeeded(deps: WorkflowServiceDeps, owner: WorkflowOwner, workflowId: string): Promise<{ needsApproval?: string[]; next?: string }> {
  const review = await analyzeWorkflowPermissions(deps, owner, workflowId);
  if (!review) return {};
  const needsApproval = [...gatingActionIds(review), ...(review.accountConsent?.pending ?? []).map((service) => `${service} shared account`)];
  return needsApproval.length === 0 ? {} : { needsApproval,
    next: "When the workflow is built, call workflows.allow_permissions once so the person allows these in one card. Until then runs stop at these steps." };
}

function ownerFromContextUnmarked(ctx: PluginActionContext): WorkflowOwner | null {
  // A channel sender with no Valet account runs as the rule's creator, but is
  // not that person: they may not manage the workspace's workflows.
  if (ctx.externalSender) return null;
  const { userId, orgId } = ctx as { userId?: unknown; orgId?: unknown };
  if (typeof userId !== "string" || userId.length === 0) return null;
  if (typeof orgId !== "string" || orgId.length === 0) return null;
  const actorUserId = ctx.actor?.id ?? userId;
  const principal = ctx.owner;
  if (principal?.type === "user") {
    if (principal.id !== actorUserId) return null;
    return { userId: actorUserId, orgId, principal: { type: "user", id: principal.id } };
  }
  if (principal?.type === "team") {
    // A team assistant with no acting user carries the team's own
    // principal id as its user id (`team:{id}`). That value is the
    // session's server-derived owner, not a person, so a membership read
    // of it always fails. Unattended runs — schedules, events, webhooks —
    // reach the workflow tools through exactly that context.
    //
    // The gate therefore turns on the ACTING user id above (the turn's
    // author when it has one, else the session's own user id): every value
    // other than the assistant's own team principal id names a person, and
    // a person's turn always carries an author.
    //
    // Three submitters set that author, and each one sets it from an
    // authenticated person: `routes/messages.ts` (the web client's own
    // prompt), `channels/host.ts` (a linked channel identity), and
    // `events/assistant-delivery.ts` (the actor an event subscription was
    // created by).
    //
    // A fourth submitter sets NO author: `orchestrator/signals.ts`
    // (`admitSignal`). A signal therefore reads as a machine turn and
    // widens this gate. `authorizeEdge` in that file is what bounds the
    // widening: it admits a parent-to-child or child-to-parent edge, and an
    // org-owned assistant to a user-owned one within one organization. A
    // user-to-user or user-to-team assistant edge is denied, so a person
    // cannot reach a team's workflows by signalling its assistant.
    //
    // The comparison assumes a principal id holds no colon. A user id
    // spelled `team:{id}` would otherwise read as that team's own machine
    // principal. Every id this code sees is a generated identifier, so
    // there is no runtime check here.
    const machinePrincipal = actorUserId === `${principal.type}:${principal.id}`;
    return {
      userId: actorUserId,
      orgId,
      principal: { type: "team", id: principal.id },
      requireTeamMembership: ctx.sessionPurpose !== "workflow" && !machinePrincipal,
    };
  }
  return { userId: actorUserId, orgId };
}

const NO_OWNER: PluginActionResult = {
  success: false,
  error: "no authenticated principal in tool context",
};

/**
 * Curried action builder (same shape as plugin-github's): the first call
 * binds T from the parameters schema; the second types `execute`'s args via
 * Static<T>, sidestepping TS's contextual-inference depth limit.
 */
function action<TParams extends TSchema>(parameters: TParams) {
  return (rest: {
    id: string;
    name: string;
    description: string;
    riskLevel: PluginAction["riskLevel"];
    execute: (args: Static<TParams>, ctx: PluginActionContext) => Promise<PluginActionResult>;
  }): PluginAction<TParams> => ({ ...rest, parameters });
}

/**
 * `getDeps` is a getter (not the deps object) because the plugin list is
 * assembled before the workflow store / run host exist at boot — same
 * one-slot-indirection pattern `providers/node.ts` uses for `childSpawner`.
 * It throws until provider wiring completes; actions only execute long
 * after boot, so callers never observe the window.
 */
/** The credential reads the team arm gate makes before a schedule or a
 * trigger arms (`team-service-readiness.ts#teamArmBlock`). */
function armDepsFrom(deps: WorkflowServiceDeps): TeamServiceReadinessDeps {
  return { db: deps.db, credentials: deps.credentials, plugins: deps.plugins ?? [], onePassword: deps.onePassword };
}

/** Steps whose actions the permission preview cannot see: an agent decides
 * them, or a sub-workflow runs them. A foreach reports its body's type. */
function uncheckedSteps(definition: unknown): Array<{ nodeId: string; type: string }> {
  const nodes = typeof definition === "object" && definition !== null && "nodes" in definition && Array.isArray(definition.nodes)
    ? definition.nodes : [];
  const unchecked: Array<{ nodeId: string; type: string }> = [];
  for (const node of nodes) {
    if (typeof node !== "object" || node === null || !("id" in node) || typeof node.id !== "string") continue;
    const body = "body" in node && typeof node.body === "object" && node.body !== null ? node.body : undefined;
    const typed = body ?? node;
    const type = "type" in typed && typeof typed.type === "string" ? typed.type : "";
    if (["session", "llm", "orchestrator", "workflow"].includes(type)) unchecked.push({ nodeId: node.id, type });
  }
  return unchecked;
}

/** What resolve_approval tells the assistant after a person answers the card,
 * when this conversation started the run, so the run's signals arrive here. */
export const RESOLVED_GATE_NEXT =
  "The run continues. A workflow.settled signal reports its result in this thread, " +
  "and a workflow.approval_needed signal says when it waits again. " +
  "Tell the person the gate is resolved, then end your turn. Do not call get_run to wait for the result.";

/** True when the run's signals reach this conversation. They go only to the
 * thread that started the run (`signalOrigin` in run-attention.ts), and a
 * sub-run reports nowhere. */
export function runReportsToThread(
  params: Pick<WorkflowRun["params"], "origin" | "parentRunId">,
  sessionId: string | undefined,
  threadId: string | undefined,
): boolean {
  const origin = params.origin;
  return params.parentRunId === undefined && origin !== undefined
    && origin.assistantSessionId === sessionId && origin.threadId === threadId;
}

/** The same, when another conversation started the run (or none did). The
 * run's signals go only to the conversation that started it, so this one
 * must read the result itself. */
export const RESOLVED_GATE_NEXT_ELSEWHERE =
  "The run continues, but its signals go to the conversation that started it, not this one. " +
  "To tell the person the result here, call get_run when they ask or after a short wait.";

/** The approval signal a gate waits on: `approval:{nodeId}`, with
 * `:{iteration}` only after the first item (`resolveWorkflowApproval`). */
function approvalSignalType(nodeId: string, iteration: number | undefined): string {
  const iter = iteration ?? 0;
  return `approval:${nodeId}${iter > 0 ? `:${iter}` : ""}`;
}

/**
 * The gates that waited before this approval and still wait after it. The
 * run wakes as soon as the approval is recorded, so the read after it can
 * race the drive: it can still list the approved gate, or list a gate the
 * drive just opened. The approved gate is not waiting, and a newly opened
 * gate gets its own workflow.approval_needed signal, so both are left out.
 */
export function gatesStillWaiting<G extends { nodeId: string; iteration?: number }>(
  waitingBefore: readonly { kind: string; signalType?: string }[],
  resolved: { nodeId: string; iteration?: number },
  pendingAfter: readonly G[],
): G[] {
  const before = new Set(waitingBefore.flatMap((w) => (w.kind === "signal" && w.signalType ? [w.signalType] : [])));
  before.delete(approvalSignalType(resolved.nodeId, resolved.iteration));
  return pendingAfter.filter((gate) => before.has(approvalSignalType(gate.nodeId, gate.iteration)));
}

/** The same, when other approvals were already waiting on the run. A
 * workflow.approval_needed signal reports only a gate a drive opens, so no
 * signal names these steps: the assistant must name them now. */
export function resolvedGateStillWaiting(gates: { nodeId: string; iteration?: number; approver?: { name?: string } }[]): string {
  const steps = gates.map((gate) => {
    const step = gate.iteration === undefined ? gate.nodeId : `${gate.nodeId} (item ${gate.iteration})`;
    return gate.approver?.name ? `${step}, which ${gate.approver.name} must approve` : step;
  });
  return `The run still waits for approval at ${steps.join("; ")}. ` +
    "These steps were already waiting, so no new signal reports them. " +
    "Tell the person which steps still wait and who must approve each. Do not say the run continues.";
}

export function workflowsActionPlugin(getDeps: () => WorkflowServiceDeps): ActionPlugin {
  const copyToTeam = action(Type.Object({
    workflow_id: Type.String({ description: "Explicit personal workflow ID to copy." }),
    team_id: Type.String({ description: "Explicit destination team ID." }),
    name: Type.String({ description: "New workflow name in the destination team. Must not exist." }),
  }))({
    id: "workflows.copy_to_team",
    name: "Copy workflow to team",
    description: "Copy an explicit personal workflow JSON graph into a team under a new name. Requires membership. Returns the destination ID. Leaves the original and its triggers unchanged. Copies no schedules, event triggers, webhook secrets, credentials or nested workflows. Referenced IDs stay unchanged and may need remapping before team use.",
    riskLevel: "medium",
    execute: async ({ workflow_id, team_id, name }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      if (ctx.owner && (ctx.owner.type !== "user" || ctx.owner.id !== owner.userId)) {
        return { success: false, error: "Copy personal workflows from your personal assistant." };
      }
      try {
        const copy = await copyWorkflowDefinition(getDeps(), owner, workflow_id, { teamId: team_id, name });
        if (!copy) return { success: false, error: "Personal workflow not found. Check the source workflow ID." };
        return { success: true, data: { workflowId: copy.id, teamId: copy.ownerId, name: copy.name,
          note: "Copied graph only. Referenced IDs are unchanged; check team access before running or adding triggers." } };
      } catch (err) {
        if (err instanceof ValetError) return { success: false, error: err.message };
        throw err;
      }
    },
  });

  const listWorkflows = action(Type.Object({}))({
    id: "workflows.list_workflows",
    name: "List workflows",
    description: "List the assistant owner's workflow definitions (id, name, timestamps).",
    riskLevel: "low",
    execute: async (_args, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const workflows = await listWorkflowDefinitions(getDeps(), owner);
      return {
        success: true,
        data: {
          workflows: workflows.map((w) => ({
            workflowId: w.id,
            name: w.name,
            updatedAt: w.updatedAt,
          })),
        },
      };
    },
  });

  const getWorkflow = action(Type.Object({ workflow_id: Type.String() }))({
    id: "workflows.get_workflow",
    name: "Get workflow",
    description: "Fetch one workflow definition (full dag/v1 nodes + edges) by id.",
    riskLevel: "low",
    execute: async ({ workflow_id }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const wf = await getWorkflowDefinition(getDeps(), owner, workflow_id);
      if (!wf) return { success: false, error: `workflow not found: ${workflow_id}` };
      return {
        success: true,
        data: {
          workflowId: wf.id,
          name: wf.name,
          definition: wf.definition,
          updatedAt: wf.updatedAt,
        },
      };
    },
  });

  // The assistant's copy of `GET /api/workflows/:id/permissions`: the same
  // analysis and the same owner check, so it never reports a gate the
  // workflow page does not show.
  const getPermissions = action(Type.Object({ workflow_id: Type.String() }))({
    id: "workflows.get_permissions",
    name: "Get workflow step permissions",
    description:
      "Show what policy decides for each tool step of a workflow, as the workflow page's Permissions section shows it. " +
      "Per step: mode `allow` means no policy gates the step, `require_approval` waits for a person, `deny` is blocked " +
      "by policy, and `unknown` is checked when the run reaches it. `provenance` names the rule that set the mode. " +
      "`sharedAccount: true` means a run may use a member's shared account and then asks that member, whatever the mode; a team 1Password item for the service avoids it. " +
      "`runtimeParams: true` means a policy rule keys on a parameter the step fills in at run time, so a run can decide differently. " +
      "`unchecked` lists agent and sub-workflow steps; their actions are checked when they run. " +
      "Read this before you tell a user that a step needs approval, and check a run's `waitingOn` to confirm.",
    riskLevel: "low",
    execute: async ({ workflow_id }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const deps = getDeps();
      const summary = await getWorkflowDefinition(deps, owner, workflow_id);
      if (!summary) return { success: false, error: `workflow not found: ${workflow_id}` };
      const nodes = await analyzeDefinitionPermissions(deps, owner, summary);
      return { success: true, data: { workflowId: workflow_id, nodes, unchecked: uncheckedSteps(summary.definition) } };
    },
  });

  // The one explicit build-time confirmation an assistant can ask for. A save
  // allows nothing: the saved steps can come from untrusted content, so the
  // person reads the actions in this card and allows them for these steps.
  const allowPermissions = action(Type.Object({ workflow_id: Type.String() }))({
    id: "workflows.allow_permissions",
    name: "Ask to allow workflow permissions",
    description:
      "Ask the person, in one approval card, to allow the saved workflow's steps that need approval and their own shared accounts " +
      "for every later run of these steps, so runs never stop to ask. Call it once after the workflow is built, when save_workflow or " +
      "patch_workflow lists `needsApproval`, and before a test run. Only the person can approve the card. Any later step change asks again. " +
      "Explicit organization and team policies still apply.",
    // The call always asks the person (below), so the catalog's own card would ask twice.
    riskLevel: "low",
    execute: async ({ workflow_id }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      if (!isDirectActor(ctx, owner)) {
        return { success: false, error: "Only the person can allow workflow permissions, in their own conversation or on the workflow page under Permissions, Review permissions." };
      }
      const deps = getDeps();
      // The person decides with their own reach, never the assistant's team principal.
      const person: WorkflowOwner = { userId: owner.userId, orgId: owner.orgId, principal: { type: "user", id: owner.userId }, humanAccountConsent: true };
      const summary = await getWorkflowDefinition(deps, person, workflow_id);
      const review = summary ? await analyzeWorkflowPermissions(deps, person, workflow_id) : null;
      if (!summary || !review) return { success: false, error: `workflow not found: ${workflow_id}` };
      const canGrant = await canGrantWorkflowPermissions(deps, person, summary);
      // An explicit policy keeps its own question; only the rest can be allowed here.
      const gating = review.nodes.filter((node) => needsGrant(node) && node.actionId);
      const grantable = canGrant ? gating.filter((node) => !POLICY_HELD.has(node.provenance ?? "")) : [];
      const held = gating.filter((node) => POLICY_HELD.has(node.provenance ?? ""));
      const actions = [...new Set(grantable.flatMap((node) => node.actionId ? [node.actionId] : []))];
      const accounts = review.accountConsent?.pending ?? [];
      if (actions.length === 0 && accounts.length === 0) {
        return { success: true, data: { workflowId: workflow_id, allowed: [], accounts: [], next: canGrant || gating.length === held.length
          ? "Nothing more can be allowed here. Steps that an explicit policy holds still ask on every run."
          : "Only the workflow owner or a team admin can allow its actions. Ask one of them to review permissions on the workflow page." } };
      }
      // The card shows each step with its exact parameters, so the person
      // reads what will run, not only an action name the assistant chose.
      const name = oneLine(summary.name, 80);
      const lines = [
        `Runs of "${name}" will run these steps without asking:`,
        ...grantable.map((node) => `- ${node.nodeId}: ${node.actionId} ${node.agentStep ? "(an agent step: the agent chooses when and with which values)"
          : oneLine(JSON.stringify(stepParams(summary.definition, node.nodeId) ?? {}), 240)}`),
        ...(accounts.length ? [`They may use your accounts shared with ${oneLine(review.accountConsent?.teamName ?? "the team", 80)}: ${accounts.join(", ")}.`] : []),
        ...(held.length ? [`These still ask on every run, because a policy requires it: ${[...new Set(held.map((node) => node.actionId))].join(", ")}.`] : []),
        "A change to the steps asks again.",
      ];
      const decision = await ctx.requestDecision({
        type: "approval",
        title: `Allow "${name}" to run without asking?`,
        body: lines.join("\n"),
        actions: [{ id: "approve", label: "Allow", style: "primary" }, { id: "cancel", label: "Not now" }],
        resumeKey: `workflow-permissions:${workflow_id}:${review.definitionToken}`,
        // Only this person answers: not a teammate, and not a team API key
        // that records its minting admin as the resolver (`answersGate`).
        context: { approver: { userId: owner.userId } },
      });
      if (decision.actionId !== "approve") return { success: false, error: "The person did not allow the permissions, so runs still stop at those steps." };
      // The thread owner answers approvals, so this is the same person.
      if (decision.resolvedBy !== owner.userId) return { success: false, error: "Only the person who asked can allow these permissions. Ask them to approve the card." };
      const outcome = await allowWorkflowPermissions(deps, person, workflow_id, canGrant ? actions : [], review.definitionToken);
      if (!outcome) return { success: false, error: `workflow not found: ${workflow_id}` };
      if (!outcome.ok) return { success: false, error: outcome.badRequest };
      return { success: true, data: { workflowId: workflow_id, allowed: outcome.result.allowed, blocked: outcome.result.blocked, accounts } };
    },
  });

  const saveWorkflow = action(
    Type.Object({
      workflow_id: Type.Optional(Type.String()),
      name: Type.Optional(Type.String()),
      definition: Type.Unknown(),
    }),
  )({
    id: "workflows.save_workflow",
    name: "Save workflow",
    description:
      "Create a workflow for the assistant owner (omit workflow_id) or update one (pass workflow_id). " +
      "`definition` MUST be a dag/v1 object: { version: 'dag/v1', nodes: [...], edges: [...] } " +
      "using node types trigger|set|if|wait|approval|session|orchestrator|tool|llm|stop|foreach|workflow. " +
      "The app labels an `orchestrator` step \"Thread\"; its stored type is still `orchestrator`. " +
      "The definition is validated before saving; validation errors come back in `error`. " +
      "A save allows nothing. When the result lists `needsApproval`, call workflows.allow_permissions once so the person allows those steps in one card. " +
      "Returns { workflowId } — always surface it to the user.",
    riskLevel: "medium",
    execute: async ({ workflow_id, name, definition }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;

      // The validate env is best-effort: if deps aren't wired (early boot,
      // or a test that only exercises validation), lint without the
      // catalog hooks rather than failing the whole call.
      let validationDeps: WorkflowServiceDeps | undefined;
      try {
        validationDeps = getDeps();
      } catch {
        validationDeps = undefined;
      }
      const env = validationDeps
        ? await buildOrgValidateEnvironment(validationDeps, owner.orgId)
        : buildValidateEnvironment();
      const validation = validateDefinitionInput(definition, env);
      if (!validation.ok) {
        return {
          success: false,
          error: formatLintErrors(validation.errors),
        };
      }

      if (workflow_id) {
        const updated = await updateWorkflowDefinition(getDeps(), owner, workflow_id, {
          name,
          definition,
        });
        if (!updated) return { success: false, error: `workflow not found: ${workflow_id}` };
        return {
          success: true,
          data: { workflowId: updated.id, name: updated.name, updatedAt: updated.updatedAt, ...(await approvalNeeded(getDeps(), owner, updated.id)) },
        };
      }

      const created = await createWorkflowDefinition(getDeps(), owner, {
        name: name ?? "Untitled workflow",
        definition,
        ...(owner.principal?.type === "team" ? { teamId: owner.principal.id } : {}),
      });
      return {
        success: true,
        data: { workflowId: created.id, name: created.name, updatedAt: created.updatedAt, ...(await approvalNeeded(getDeps(), owner, created.id)) },
      };
    },
  });

  const startRun = action(
    Type.Object({
      workflow_id: Type.String(),
      input: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }),
  )({
    id: "workflows.start_run",
    name: "Start workflow run",
    description:
      "Start a run of a workflow. Optional `input` becomes the trigger payload data. " +
      "Returns { runId, workflowId } — always surface the runId to the user. " +
      "When the run completes, fails, or is cancelled, a workflow.settled signal reports the result in this thread. " +
      "When it waits for approval, a workflow.approval_needed signal says so. " +
      "Read followUp and next before promising a later reply. When followUp.registered is true, " +
      "end your turn and continue from that signal; do not poll. Otherwise check get_run.",
    riskLevel: "medium",
    execute: async ({ workflow_id, input }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const deps = getDeps();
      const origin = await workflowActionOrigin(deps, owner, ctx.sessionId, ctx.threadId, ctx.owner);
      // Only the person's own signed-in prompt starts a run whose agent steps may use saved grants.
      // The run gets the caller's ceiling. The caller's thread focus is its own and stays with it.
      const started = await startWorkflowRun(deps, owner, workflow_id, input, origin, "manual", ctx.toolScopeCeiling, ctx.toolScopeCeiling ?? {},
        undefined, isDirectActor(ctx, owner) ? "person" : "agent");
      if (!started) return { success: false, error: `workflow not found: ${workflow_id}` };
      if ("invalidInput" in started) {
        return {
          success: false,
          error:
            `run input is invalid: ${started.invalidInput.map((e) => e.message).join(" ")} ` +
            "Fix the listed inputs and start the run again.",
        };
      }
      return {
        success: true,
        data: {
          runId: started.runId, workflowId: workflow_id, status: "pending",
          followUp: { registered: origin !== undefined, status: origin ? "awaiting_settlement" : "no_origin" },
          next: origin
            ? "End your turn and continue from workflow.settled. Automatic completion follow-up is registered; do not poll."
            : "Call get_run to check completion. No automatic chat follow-up is registered.",
        },
      };
    },
  });

  const deleteWorkflow = action(Type.Object({ workflow_id: Type.String() }))({
    id: "workflows.delete_workflow",
    name: "Delete workflow",
    description:
      "Permanently delete a workflow definition. Refused (with an error) while the workflow " +
      "has non-settled runs — cancel them first. Settled run history is kept. Team deletion requires " +
      "a current admin in direct web chat. Members can use request_workflow_deletion for admin review.",
    riskLevel: "medium",
    execute: async ({ workflow_id }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const directActor = isDirectActor(ctx, owner);
      let result;
      try {
        result = await deleteWorkflowDefinition(getDeps(), { ...owner, deletionAuthority: directActor ? { type: "interactive", userId: owner.userId } : { type: "automated" } }, workflow_id);
      } catch (error) {
        if (!(error instanceof TeamAdminRequiredError)) throw error;
        return {
          success: false,
          error: directActor
            ? "Only a team admin can delete this workflow. Use workflows.request_workflow_deletion to request admin review."
            : "Team workflow deletion requires a signed-in person in direct web chat. Ask a team admin there or open team settings.",
          data: { code: error.code, teamId: error.teamId,
            reviewUrl: `/settings/organization/teams?teamId=${encodeURIComponent(error.teamId)}`,
            ...(directActor ? { nextAction: "workflows.request_workflow_deletion" } : {}),
          },
        };
      }
      if (result === "not_found") {
        return { success: false, error: `workflow not found: ${workflow_id}` };
      }
      if (result === "has_active_runs") {
        return {
          success: false,
          error: `workflow ${workflow_id} has runs that are not settled — cancel them first, then delete`,
        };
      }
      return { success: true, data: { workflowId: workflow_id, deleted: true } };
    },
  });

  const requestWorkflowDeletion = action(Type.Object({
    workflow_id: Type.String(),
    reason: Type.Optional(Type.String({ maxLength: 2000 })),
  }))({
    id: "workflows.request_workflow_deletion",
    name: "Request workflow deletion",
    description: "Open or reuse a team workflow deletion request for an admin to review. This does not delete the workflow. Requires a signed-in person in direct web chat.",
    riskLevel: "medium",
    execute: async ({ workflow_id, reason }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      if (!isDirectActor(ctx, owner)) {
        return { success: false, error: "Open a deletion request from signed-in web chat or team settings. Automated turns cannot submit requests for a person." };
      }
      const deps = getDeps();
      const workflow = await getWorkflowDefinition(deps, owner, workflow_id);
      if (!workflow) return { success: false, error: `workflow not found: ${workflow_id}` };
      if (workflow.ownerType !== "team") return { success: false, error: "Deletion requests are for team workflows. Use workflows.delete_workflow for your personal workflow." };
      const { request, created } = await submitDeletionRequest(deps.db,
        { orgId: owner.orgId, userId: owner.userId, teamId: workflow.ownerId }, "workflow", workflow_id, reason);
      return { success: true, data: {
        workflowId: workflow_id, deleted: false, requestId: request.id, status: request.status, created,
        reviewUrl: `/settings/organization/teams?teamId=${encodeURIComponent(workflow.ownerId)}`,
      } };
    },
  });

  const getRun = action(Type.Object({ run_id: Type.String() }))({
    id: "workflows.get_run",
    name: "Get workflow run",
    description:
      "Fetch a run's status, outcome, per-node checkpoints, and what it is waiting on " +
      "(timers, signals, approvals). pendingGates lists each step that waits for approval and, " +
      "for a step on a teammate's shared account, the teammate who must approve it. " +
      "provenance names the server build that ran it, the server's build now, and the saved workflow version it used: " +
      "check these first, because a fix that is not deployed or an edit made after the run explains many failures.",
    riskLevel: "low",
    execute: async ({ run_id }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const deps = getDeps();
      const detail = await getWorkflowRunDetail(deps, owner, run_id);
      if (!detail) return { success: false, error: `run not found: ${run_id}` };
      const provenance = await workflowRunProvenance(deps.db, detail.run);
      return {
        success: true,
        data: {
          runId: detail.run.runId,
          workflowId: detail.run.workflowId,
          provenance,
          status: detail.run.status,
          outcome: detail.run.outcome,
          waitingOn: detail.run.waitingOn,
          followUp: await readRunFollowUp(getDeps(), owner.orgId, detail.run),
          createdAt: detail.run.createdAt,
          updatedAt: detail.run.updatedAt,
          // The steps that wait for approval, and the member who must approve
          // a step on their shared account. Anyone who can run the workflow
          // approves a step with no approver.
          pendingGates: detail.pendingGates.map((gate) => ({
            nodeId: gate.nodeId,
            ...(gate.iteration !== undefined ? { iteration: gate.iteration } : {}),
            kind: gate.kind,
            ...(gate.service ? { service: gate.service, action: gate.action } : {}),
            ...(gate.approver ? { approver: { userId: gate.approver.userId, name: gate.approver.name } } : {}),
          })),
          checkpoints: detail.checkpoints.map((cp) => ({
            nodeId: cp.nodeId,
            iteration: cp.iteration,
            status: cp.status,
            error: cp.error,
            // The session a session node drove, and the run a workflow node
            // started — how the agent reaches a failed node's actual output.
            sessionId: cp.sessionId,
            threadId: cp.threadId,
            queueItemId: cp.queueItemId,
            childRunId: cp.childRunId,
            ...(cp.repairAttempted ? { repairAttempted: true } : {}),
            ...(cp.schemaError ? { schemaError: cp.schemaError } : {}),
          })),
        },
      };
    },
  });

  const listRuns = action(
    Type.Object({
      workflow_id: Type.Optional(Type.String()),
      parent_run_id: Type.Optional(Type.String()),
      status: Type.Optional(Type.Array(Type.String())),
      limit: Type.Optional(Type.Number()),
      cursor: Type.Optional(Type.String()),
    }),
  )({
    id: "workflows.list_runs",
    name: "List workflow runs",
    description:
      "List runs (runId, status, outcome, timestamps), newest first. Omit workflow_id " +
      "for every workflow you can reach. Pass parent_run_id to track one batch's child " +
      "runs. Parked runs also carry waitingOn — the node and signal/timer each is blocked " +
      "on (signalType approval:<nodeId> = an approval node OR a policy gate on a tool " +
      "node). Use to find parked/pending runs before cancelling or checking approvals. " +
      "Paginated: pass the returned nextCursor back as cursor for the next page.",
    riskLevel: "low",
    execute: async ({ workflow_id, parent_run_id, status, limit, cursor }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const badStatus = status?.filter((s) => !isRunStatus(s));
      if (badStatus && badStatus.length > 0) {
        return {
          success: false,
          error: `unknown run status ${badStatus.join(", ")} — use one of: ${RUN_STATUS_VALUES.join(", ")}`,
        };
      }
      let page;
      try {
        page = await listRunsForOwner(getDeps(), owner, {
          workflowIds: workflow_id === undefined ? undefined : [workflow_id],
          status: status?.filter(isRunStatus),
          parentRunId: parent_run_id,
          limit,
          cursor,
        });
      } catch (err) {
        if (err instanceof WorkflowCursorError) return { success: false, error: err.message };
        throw err;
      }
      if (!page) return { success: false, error: `workflow not found: ${workflow_id}` };
      return { success: true, data: { workflowId: workflow_id, ...page } };
    },
  });

  const cancelRun = action(Type.Object({ run_id: Type.String() }))({
    id: "workflows.cancel_run",
    name: "Cancel workflow run",
    description:
      "Terminate a run (running, parked on a wait, or pending approval). Settling is " +
      "asynchronous — re-check with get_run after a few seconds if a follow-up (e.g. " +
      "delete_workflow) reports active runs.",
    riskLevel: "medium",
    execute: async ({ run_id }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      // Self-invocation guard: a workflow session must not cancel runs.
      const sessionId = (ctx as { sessionId?: unknown }).sessionId;
      if (typeof sessionId === "string" && sessionId.startsWith("wf:invoke:")) {
        return { success: false, error: "A workflow cannot cancel runs. Request cancellation through the web UI or API." };
      }
      const result = await cancelWorkflowRun(getDeps(), owner, run_id);
      if (result === "not_found") return { success: false, error: `run not found: ${run_id}` };
      return { success: true, data: { runId: run_id, cancelled: true } };
    },
  });

  const retryRun = action(
    Type.Object({
      run_id: Type.String(),
      from: Type.Union([Type.Literal("failed_step"), Type.Literal("start")]),
      input: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }),
  )({
    id: "workflows.retry_run",
    name: "Retry workflow run",
    description:
      "Run a failed or cancelled run again on the current saved workflow. " +
      "from \"failed_step\" reuses every finished step before the failure, so only the failed step and the steps after it run; " +
      "a foreach keeps its finished items. A step edited since the run, and every step after it, runs again. " +
      "from \"start\" runs every step; with it, `input` replaces some trigger inputs, for example a shorter date range for a test run. " +
      "The retry keeps the old run's audience and follow-up conversation. Returns { runId }; check the result with get_run.",
    riskLevel: "medium",
    execute: async ({ run_id, from, input }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const sessionId = (ctx as { sessionId?: unknown }).sessionId;
      if (typeof sessionId === "string" && sessionId.startsWith("wf:invoke:")) {
        return { success: false, error: "A workflow cannot retry runs. Retry the run from the run page or an assistant conversation." };
      }
      const result = await retryWorkflowRun(getDeps(), owner, run_id, { from, input });
      if (result === "not_found") return { success: false, error: `run not found: ${run_id}` };
      if (result === "workflow_deleted") return { success: false, error: "This run's workflow was deleted. Create the workflow again, then start a new run." };
      if (result === "not_retryable") return { success: false, error: "Only failed or cancelled runs can be retried. Wait for the run to settle, or cancel it first." };
      if (result === "input_needs_start") return { success: false, error: "A retry from the failed step reuses the original input. To change the input, retry with from \"start\"." };
      if ("invalidInput" in result) {
        return { success: false, error: `run input is invalid: ${result.invalidInput.map((e) => e.message).join(" ")} Fix the listed inputs and retry again.` };
      }
      return { success: true, data: { runId: result.runId, retryOf: run_id, from } };
    },
  });

  const resolveApproval = action(
    Type.Object({
      run_id: Type.String(),
      node_id: Type.String(),
      approved: Type.Boolean(),
      note: Type.Optional(Type.String()),
      iteration: Type.Optional(Type.Number()),
    }),
  )({
    id: "workflows.resolve_approval",
    name: "Resolve workflow approval",
    description:
      "Approve or deny a run's pending gate: an approval node, or a tool node that policy holds. " +
      "Call it when the user asks you to resolve a gate; never resolve one on your own judgment. " +
      "Valet shows the user a card for the gate, and the gate resolves as the person who confirms it. " +
      "The run then continues. If this conversation started the run, a workflow.settled signal reports its result here, " +
      "and a workflow.approval_needed signal says when it waits again: end your turn after the call and continue from that signal; do not poll. " +
      "The result's `next` field says which case applies.",
    // The call itself always asks a person (below), so the catalog's own
    // approval card would only ask twice. A policy cannot skip that question.
    riskLevel: "medium",
    execute: async ({ run_id, node_id, approved, note, iteration }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      // Self-invocation guard: a workflow session must not resolve approval gates.
      const sessionId = (ctx as { sessionId?: unknown }).sessionId;
      if (typeof sessionId === "string" && sessionId.startsWith("wf:invoke:")) {
        return { success: false, error: "A workflow cannot resolve approval gates. A human must resolve this gate from the run page." };
      }
      const deps = getDeps();
      // Name the step only for a run the caller may read.
      const run = (await canReadWorkflowRun(deps, owner, run_id)) ? await deps.workflowStore.getRun(run_id) : null;
      if (!run) return { success: false, error: `run not found: ${run_id}` };
      const node = findNodeInDefinition(run.definition, node_id);
      const checkpoint = (await deps.workflowStore.getCheckpoints(run_id)).find(cp => cp.nodeId === node_id && cp.iteration === (iteration ?? 0) && cp.status === "intent");
      const gateId = typeof checkpoint?.effects?.gateId === "string" ? checkpoint.effects.gateId : undefined;
      const step = node?.type === "tool" && typeof node.service === "string" && typeof node.action === "string"
        ? (node.action.includes(".") ? node.action : `${node.service}.${node.action}`)
        : `step ${node_id}`;
      // A gate exists for a person. The agent relays the request, and the
      // person who answers this card resolves the gate under their own access,
      // as the run page would.
      const decision = await ctx.requestDecision({
        type: "approval",
        title: `${approved ? "Approve" : "Deny"} ${step} on this workflow run?`,
        body: [`Run ${run_id}, step ${node_id}${iteration ? `, iteration ${iteration}` : ""}.`, note].filter(Boolean).join("\n\n"),
        actions: [
          { id: "approve", label: approved ? "Approve step" : "Deny step", style: approved ? "primary" : "danger" },
          { id: "cancel", label: "Cancel" },
        ],
        resumeKey: `workflow-gate:${run_id}:${node_id}:${iteration ?? 0}:${approved ? "approve" : "deny"}${gateId ? `:${gateId}` : ""}`,
        // The person who asked answers. A team API key records its minting
        // admin as the resolver, so an open card would let it act as that admin.
        context: { approver: { userId: owner.userId } },
      });
      if (decision.actionId !== "approve") {
        return { success: false, error: `Nobody confirmed the card, so ${node_id} on run ${run_id} still waits for a decision.` };
      }
      const person: WorkflowOwner = { userId: decision.resolvedBy, orgId: owner.orgId, principal: { type: "user", id: decision.resolvedBy } };
      // Read just before the approval: what already waits, for `next`.
      const waitingBefore = (await deps.workflowStore.getRun(run_id))?.waitingOn ?? [];
      const result = await resolveWorkflowApproval(deps, person, {
        runId: run_id,
        nodeId: node_id,
        gateId,
        approved,
        note,
        iteration,
        via: "thread",
      });
      if (result === "not_found") return { success: false, error: `run not found: ${run_id}` };
      if (result === "not_parked") return { success: false, error: `run ${run_id} is not parked on approval gate ${node_id}` };
      if (result === "stale_gate") return { success: false, error: "This approval gate changed. Read the run and review its current approval." };
      if (result === "already_resolved") return { success: false, error: `approval gate ${node_id} on run ${run_id} has already been resolved` };
      if (result === "timed_out") return { success: false, error: `approval gate ${node_id} on run ${run_id} has timed out` };
      if (result === "not_approver") return { success: false, error: "This step would use another member's shared account. Only that member can answer it." };
      if (result === "forbidden_always") return { success: false, error: "scope=always requires an org admin" };
      if (result === "org_mismatch") return { success: false, error: "not a member of this workflow's org" };
      // The result is what the assistant reads right after the card. Saying
      // here that the signal reports the run stops a get_run poll that
      // reports the run twice: once from the poll, once from the signal.
      let stillWaiting: WorkflowPendingGate[] | undefined;
      try {
        const detail = await getWorkflowRunDetail(deps, owner, run_id);
        if (detail) stillWaiting = gatesStillWaiting(waitingBefore, { nodeId: node_id, iteration }, detail.pendingGates);
      } catch (err) {
        // The approval is already recorded. A failed read only loses the
        // still-waiting list; it must not turn a success into a failure.
        console.warn(`resolve_approval: could not read run ${run_id} after the approval:`, err);
      }
      const next = stillWaiting === undefined
        ? "The gate is resolved, but the run's waiting state could not be read. Call get_run to check for remaining approvals."
        : stillWaiting.length > 0
        ? resolvedGateStillWaiting(stillWaiting)
        : runReportsToThread(run.params, ctx.sessionId, ctx.threadId) ? RESOLVED_GATE_NEXT : RESOLVED_GATE_NEXT_ELSEWHERE;
      return { success: true, data: { runId: run_id, nodeId: node_id, approved, next } };
    },
  });

  const patchWorkflow = action(
    Type.Object({
      workflow_id: Type.String(),
      name: Type.Optional(Type.String()),
      presence: Type.Optional(Type.Union([Type.Object({
        displayName: Type.Optional(Type.String()),
        avatarUrl: Type.Optional(Type.String()),
      }), Type.Null()])),
      upsert_nodes: Type.Optional(Type.Array(Type.Unknown())),
      remove_node_ids: Type.Optional(Type.Array(Type.String())),
      add_edges: Type.Optional(
        Type.Array(
          Type.Object({
            from: Type.String(),
            to: Type.String(),
            fromOutput: Type.Optional(Type.Union([Type.Literal("true"), Type.Literal("false")])),
            when: Type.Optional(Type.String()),
          }),
        ),
      ),
      remove_edges: Type.Optional(
        Type.Array(
          Type.Object({
            from: Type.String(),
            to: Type.String(),
            fromOutput: Type.Optional(Type.Union([Type.Literal("true"), Type.Literal("false")])),
          }),
        ),
      ),
    }, { additionalProperties: false }),
  )({
    id: "workflows.patch_workflow",
    name: "Patch workflow",
    description:
      "Edit a workflow WITHOUT re-sending the whole definition: rename, upsert single nodes " +
      "(replace-by-id or append), remove nodes (their edges go too), add/remove edges, or set presence. " +
      "Presence replaces the channel identity; null clears it. " +
      "Prefer this over save_workflow for small edits — the patched result runs the full " +
      "linter, so a bad patch returns lint errors instead of saving. The linter reads the " +
      "WHOLE merged definition, so an error in a node you did not touch also blocks the " +
      "patch; the reply names those errors as pre-existing.",
    riskLevel: "medium",
    execute: async ({ workflow_id, name, presence, upsert_nodes, remove_node_ids, add_edges, remove_edges }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const deps = getDeps();
      const wf = await getWorkflowDefinition(deps, owner, workflow_id);
      if (!wf) return { success: false, error: `workflow not found: ${workflow_id}` };

      const stored = wf.definition;
      if (
        typeof stored !== "object" ||
        stored === null ||
        !Array.isArray((stored as { nodes?: unknown }).nodes) ||
        !Array.isArray((stored as { edges?: unknown }).edges)
      ) {
        return { success: false, error: "stored definition is not a dag/v1 workflow" };
      }

      const patched = applyWorkflowPatch(stored as WorkflowDefinition, {
        presence,
        upsertNodes: upsert_nodes,
        removeNodeIds: remove_node_ids,
        addEdges: add_edges as WorkflowEdge[] | undefined,
        removeEdges: remove_edges as WorkflowEdgeRef[] | undefined,
      });
      if (!patched.ok) return { success: false, error: formatLintErrors(patched.errors) };

      // A rename changes no node and no edge, so it cannot introduce a lint
      // error. Revalidating anyway would refuse to rename a workflow that
      // already holds one — while `PUT /api/workflows/:id` renames the same
      // workflow without complaint, because it validates only when the
      // request carries a definition. Match that, and keep the two surfaces
      // from disagreeing about the same edit.
      const changesGraph =
        (upsert_nodes !== undefined && upsert_nodes.length > 0) ||
        (remove_node_ids !== undefined && remove_node_ids.length > 0) ||
        (add_edges !== undefined && add_edges.length > 0) ||
        (remove_edges !== undefined && remove_edges.length > 0);

      if (changesGraph) {
        const env = await buildOrgValidateEnvironment(deps, owner.orgId);
        const validation = validateDefinitionInput(patched.definition, env);
        if (!validation.ok) {
          // Validate the stored definition too, so the reply can say which
          // errors the patch introduced and which the workflow already held.
          const before = validateDefinitionInput(stored, env);
          // When the patch removed edges and the lint reports unreachable
          // nodes, the removal is the likely cause — say so in one line.
          const withHint = appendRemovedEdgeHint(
            validation.errors,
            remove_edges as WorkflowEdgeRef[] | undefined,
          );
          return {
            success: false,
            error: formatEditLintErrors(withHint, before.ok ? [] : before.errors),
          };
        }
      }

      const updated = await updateWorkflowDefinition(deps, owner, workflow_id, {
        name,
        definition: patched.definition,
      });
      if (!updated) return { success: false, error: `workflow not found: ${workflow_id}` };
      return {
        success: true,
        data: {
          workflowId: updated.id,
          name: updated.name,
          nodes: patched.definition.nodes.length,
          edges: patched.definition.edges.length,
          ...(await approvalNeeded(deps, owner, updated.id)),
        },
      };
    },
  });

  const updateModel = action(
    Type.Object({
      workflow_id: Type.String(),
      model: Type.String({ description: "An approved catalog model id or a size tier: xs, s, m, l, xl." }),
      node_ids: Type.Optional(Type.Array(Type.String(), {
        description: "Only these llm or session nodes. Omit to update all model-capable nodes.",
      })),
    }),
  )({
    id: "workflows.update_model",
    name: "Update workflow model",
    description:
      "Change the model on selected llm or session nodes without replacing the workflow definition. " +
      "Omit node_ids to update all such nodes, including foreach bodies. Orchestrator nodes use their " +
      "assistant's saved model and are not changed. The model must be an approved active catalog model " +
      "or an org model tier.",
    riskLevel: "medium",
    execute: async ({ workflow_id, model, node_ids }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const deps = getDeps();
      const catalog = await buildOrgCatalog(deps.db, deps.credentials, owner.orgId);
      if (!catalogValidIds(catalog).has(model)) {
        return {
          success: false,
          error: `unknown or inactive model: ${model}. Pick an approved model from GET /api/models, or use xs, s, m, l, or xl.`,
        };
      }
      const concrete = catalog.find((entry) =>
        entry.id === model || (entry.id.startsWith("anthropic/") && entry.id.slice("anthropic/".length) === model),
      );
      if (concrete && !concrete.approved) {
        return { success: false, error: `model ${model} is not approved. Choose an approved model or an org model tier.` };
      }

      const wf = await getWorkflowDefinition(deps, owner, workflow_id);
      if (!wf) return { success: false, error: `workflow not found: ${workflow_id}` };
      const stored = validateDefinitionInput(wf.definition);
      if (!stored.ok) return { success: false, error: formatLintErrors(stored.errors) };
      const patched = applyWorkflowModelPatch(stored.definition, model, node_ids);
      if (!patched.ok) return { success: false, error: formatLintErrors(patched.errors) };
      const validation = validateDefinitionInput(patched.definition, await buildOrgValidateEnvironment(deps, owner.orgId));
      if (!validation.ok) return { success: false, error: formatLintErrors(validation.errors) };
      const updated = await updateWorkflowDefinition(deps, owner, workflow_id, { definition: patched.definition });
      if (!updated) return { success: false, error: `workflow not found: ${workflow_id}` };
      return { success: true, data: { workflowId: updated.id, model, nodeIds: patched.nodeIds, ...(await approvalNeeded(deps, owner, updated.id)) } };
    },
  });

  const addAggregate = action(
    Type.Object({
      workflow_id: Type.String(),
      mode: Type.Optional(Type.Union([Type.Literal("collect"), Type.Literal("summarize")])),
      model: Type.Optional(Type.String()),
      node_id: Type.Optional(Type.String()),
      sources: Type.Optional(Type.Array(Type.String())),
      instructions: Type.Optional(Type.String()),
    }),
  )({
    id: "workflows.add_aggregate",
    name: "Add aggregation node",
    description:
      "Append a node that combines several parallel branches into one result, wired with the " +
      "correct template path for each branch's node type (an llm branch reads result.text, a " +
      "session branch result.response, a branch with an outputSchema result.output). " +
      'mode "collect" (default) writes a set node with one field per branch; mode "summarize" ' +
      "writes an llm node and needs `model`. Omit `sources` to take every branch with no " +
      "outgoing edge. The node is an ordinary node afterwards — editable and removable like any other.",
    riskLevel: "medium",
    execute: async ({ workflow_id, mode, model, node_id, sources, instructions }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const deps = getDeps();
      const result = await addAggregateNode(
        deps,
        owner,
        workflow_id,
        { mode, model, nodeId: node_id, sources, instructions },
        await buildOrgValidateEnvironment(deps, owner.orgId),
      );
      if (!result.ok) {
        if (result.reason === "not_found") return { success: false, error: `workflow not found: ${workflow_id}` };
        // This action appends a node to the stored definition, so an error
        // the stored definition already held blocks it. Say so: the caller
        // cannot see the offending node from the arguments it sent.
        //
        // Both arguments are the same list ON PURPOSE. This reason code is
        // raised by validating the STORED definition alone, before the node
        // is appended (`addAggregateNode`), so every error in it is by
        // definition pre-existing. An error the appended node introduces
        // arrives under `would_be_invalid` instead, and is formatted below
        // as the caller's own. Keep the two reason codes apart if this
        // action ever takes a user-supplied path.
        if (result.reason === "stored_definition_invalid") {
          return { success: false, error: formatEditLintErrors(result.errors, result.errors) };
        }
        // Two failure shapes: a lint list, or one sentence naming the fix.
        if ("errors" in result) return { success: false, error: formatLintErrors(result.errors) };
        return { success: false, error: result.message };
      }
      return {
        success: true,
        data: {
          workflowId: result.definition.id,
          nodeId: result.nodeId,
          sources: result.sources,
          updatedAt: result.definition.updatedAt,
          ...(await approvalNeeded(getDeps(), owner, result.definition.id)),
        },
      };
    },
  });

  const getNodeResult = action(
    Type.Object({
      run_id: Type.String(),
      node_id: Type.String(),
      iteration: Type.Optional(Type.Number()),
    }),
  )({
    id: "workflows.get_node_result",
    name: "Get node result",
    description:
      "Fetch a run node's FULL checkpoint output (result + error) — use when debugging a " +
      "failed or surprising node; get_run intentionally omits result bodies. `result` is " +
      "the checkpoint value verbatim (the same value templates read via nodes.<id>.result); " +
      "an oversized result comes back as { truncated: true, jsonPrefix }. Foreach body " +
      "nodes have one checkpoint per iteration; pass `iteration` to narrow.",
    riskLevel: "low",
    execute: async ({ run_id, node_id, iteration }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const detail = await getWorkflowRunDetail(getDeps(), owner, run_id);
      if (!detail) return { success: false, error: `run not found: ${run_id}` };
      const matches = detail.checkpoints.filter(
        (cp) => cp.nodeId === node_id && (iteration === undefined || cp.iteration === iteration),
      );
      if (matches.length === 0) {
        const known = [...new Set(detail.checkpoints.map((cp) => cp.nodeId))];
        return {
          success: false,
          error: `run ${run_id} has no checkpoint for node ${JSON.stringify(node_id)} (nodes with checkpoints: ${known.join(", ") || "none"})`,
        };
      }
      return {
        success: true,
        data: {
          runId: run_id,
          nodeId: node_id,
          checkpoints: matches.map((cp) => ({
            iteration: cp.iteration,
            status: cp.status,
            error: cp.error,
            result: presentResult(cp.result, TOOL_RESULT_CHARS),
          })),
        },
      };
    },
  });

  const getNodeDiagnostics = action(Type.Object({
    run_id: Type.String(),
    node_id: Type.String(),
    iteration: Type.Optional(Type.Integer({ minimum: 0 })),
  }))({
    id: "workflows.get_node_diagnostics",
    name: "Get node diagnostics",
    description:
      "Trace a failed or empty session/orchestrator result through its original and repair submissions. " +
      "Returns submission status, selected message ID, stored text and text-part lengths, stop reason, " +
      "provider error, model, usage and cost where recorded. Missing fields are unavailable evidence. " +
      "No prompts or result bodies are returned. Use get_node_transcript for content and get_node_result for checkpoint output. " +
      "Pass iteration to select one checkpoint of a foreach node.",
    riskLevel: "low",
    execute: async ({ run_id, node_id, iteration }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const deps = getDeps();
      const detail = await getWorkflowRunDetail(deps, owner, run_id);
      if (!detail) return { success: false, error: `run not found: ${run_id}` };
      const matches = (await deps.workflowStore.getCheckpoints(run_id))
        .filter(cp => cp.nodeId === node_id && (iteration === undefined || cp.iteration === iteration));
      if (!matches.length) return { success: false, error: `No checkpoint for node ${JSON.stringify(node_id)}. Call get_run to list recorded nodes.` };
      if (matches.length > 1) return { success: false, error: "Multiple iterations match. Pass iteration to inspect one checkpoint." };
      return { success: true, data: { runId: run_id, nodeId: node_id,
        checkpoints: await Promise.all(matches.map(cp => readNodeDiagnostics(deps.engineStore, cp))) } };
    },
  });

  const getNodeTranscript = action(
    Type.Object({
      run_id: Type.String(),
      node_id: Type.String(),
      iteration: Type.Optional(Type.Number()),
      message_id: Type.Optional(Type.String({ description: "Read one message or tool field in full using bounded character slices." })),
      content_field: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("tool_args"), Type.Literal("tool_result"), Type.Literal("tool_error")])),
      call_id: Type.Optional(Type.String()),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      before: Type.Optional(Type.Number()),
      limit: Type.Optional(Type.Number()),
    }),
  )({
    id: "workflows.get_node_transcript",
    name: "Get node transcript",
    description:
      "Read the conversation a session or orchestrator step held: the prompt it received with " +
      "templates filled in, its replies, any format-repair prompt, and each tool call with its " +
      "arguments, result, and error. Use it when a step's result is surprising and " +
      "get_node_result does not explain why. Messages come oldest first. `index` numbers each " +
      "message; pass `before` to read the page before that index. Includes saved compaction summaries and continuation markers. " +
      "For clipped content, pass message_id, content_field (text, tool_args, tool_result or tool_error), " +
      "call_id for tool fields, and offset. Read data.content.nextOffset until null.",
    riskLevel: "low",
    execute: async ({ run_id, node_id, iteration, before, limit, message_id, content_field, call_id, offset }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const detail = await getWorkflowRunDetail(getDeps(), owner, run_id);
      if (!detail) return { success: false, error: `run not found: ${run_id}` };
      const matches = detail.checkpoints.filter(
        (cp) => cp.nodeId === node_id && (iteration === undefined || cp.iteration === iteration),
      );
      if (matches.length === 0) return { success: false, error: `run ${run_id} has no checkpoint for node ${JSON.stringify(node_id)}` };
      if (matches.length > 1) {
        const iterations = matches.map((cp) => cp.iteration).sort((a, b) => a - b).join(", ");
        return { success: false, error: `Node ${JSON.stringify(node_id)} ran iterations ${iterations}. Pass iteration to choose one.` };
      }
      const checkpoint = matches[0]!;
      if (!checkpoint.sessionId) {
        return { success: false, error: `Node ${JSON.stringify(node_id)} ran no conversation. Only session and orchestrator steps keep a transcript; use get_node_result for this node.` };
      }
      const pageSize = Math.min(Math.max(Math.trunc(limit ?? TRANSCRIPT_PAGE), 1), TRANSCRIPT_PAGE_MAX);
      // A session step owns its thread, repair turn included. An orchestrator
      // step shares a thread with other steps and with chat, so it reads only
      // its own submission.
      // After a format repair the checkpoint's receipt names the repair, and
      // the stored effects keep the first submission, so both turns load.
      const ownThread = checkpoint.sessionId.startsWith("wf:");
      const stored = (await getDeps().workflowStore.getCheckpoints(run_id))
        .find((cp) => cp.nodeId === node_id && cp.iteration === checkpoint.iteration);
      const firstQueueItemId = typeof stored?.effects?.firstQueueItemId === "string" ? stored.effects.firstQueueItemId : undefined;
      const queueItemIds = [firstQueueItemId, checkpoint.queueItemId].filter((id): id is string => id !== undefined);
      const transcript = await readStepTranscript(getDeps().engineStore, checkpoint.sessionId, checkpoint.threadId, {
        ...(before !== undefined ? { before: Math.trunc(before) } : {}),
        limit: pageSize,
        ...(message_id ? { content: { messageId: message_id, field: content_field ?? "text", callId: call_id, offset: offset ?? 0 } } : {}),
        ...(!ownThread && queueItemIds.length > 0 ? { queueItemIds } : {}),
      });
      if (!transcript) return { success: false, error: `The conversation for node ${JSON.stringify(node_id)} is no longer stored.` };
      return {
        success: true,
        data: {
          runId: run_id,
          nodeId: node_id,
          iteration: checkpoint.iteration,
          sessionId: checkpoint.sessionId,
          threadId: transcript.threadId,
          ...(checkpoint.repairAttempted ? { repairAttempted: true } : {}),
          ...(checkpoint.schemaError ? { schemaError: checkpoint.schemaError } : {}),
          total: transcript.total,
          entriesMayBeTruncated: transcript.entriesMayBeTruncated,
          ...(transcript.content ? { content: transcript.content } : {}),
          ...(transcript.contentError ? { contentError: transcript.contentError } : {}),
          messages: transcript.messages,
        },
      };
    },
  });

  const previewWorkflowAction = action(
    Type.Object({
      workflow_id: Type.String(),
      input: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {
        description: "Sample trigger fields. They override the last run's trigger data.",
      })),
      sample: Type.Optional(Type.Union([Type.Literal("last_run"), Type.Literal("none")], {
        description: "last_run (default) reads node results from the newest run. none uses only `input`.",
      })),
      node_id: Type.Optional(Type.String({ description: "Return only this step. Omit for every step." })),
    }),
  )({
    id: "workflows.preview_workflow",
    name: "Preview workflow",
    description:
      "Dry-run the saved workflow with no side effects. Only trigger, set, if and stop steps run " +
      "(fidelity 'executed'). Every other step is described from its shape and never called " +
      "(fidelity 'described'). Each step lists its resolved template fields, the `unresolved` " +
      "paths that render to nothing, its output paths and warnings. Use it before a real run " +
      "to catch template and structure errors. A long value comes back as " +
      "{ truncated: true, jsonPrefix, note }; pass node_id to give one step more room.",
    riskLevel: "low",
    execute: async ({ workflow_id, input, sample, node_id }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const outcome = await previewWorkflow(getDeps(), owner, workflow_id, { input, sample, nodeId: node_id });
      if (outcome.ok) return { success: true, data: presentPreview(workflow_id, outcome.response, TOOL_RESULT_CHARS) };
      switch (outcome.reason) {
        case "not_found":
          return { success: false, error: `workflow not found: ${workflow_id}` };
        case "invalid_definition":
          return { success: false, error: formatLintErrors(outcome.errors) };
        case "unknown_node":
          return { success: false, error: outcome.message };
      }
    },
  });

  const listEventTypesAction = action(Type.Object({}))({
    id: "workflows.list_event_types",
    name: "List event types",
    description:
      "List the event keys workflows can be triggered by (per service, with filterable " +
      "fields). Use before create_trigger to pick a valid event key.",
    riskLevel: "low",
    execute: async (_args, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const services = listEventTypes(getDeps().plugins ?? []);
      if (services.length === 0) {
        return {
          success: true,
          data: { services, note: "no event-emitting integrations are connected yet" },
        };
      }
      return { success: true, data: { services } };
    },
  });

  const createTrigger = action(
    Type.Object({
      workflow_id: Type.String(),
      name: Type.String(),
      presence: Type.Optional(Type.Object({ displayName: Type.Optional(Type.String()), avatarUrl: Type.Optional(Type.String()) })),
      event_keys: Type.Array(Type.String(), {
        description: 'Event key patterns; trailing ".*" wildcard supported (e.g. "github.pull_request.*").',
      }),
      filters: Type.Optional(
        Type.Array(
          Type.Object({
            field: Type.String(),
            op: Type.Union([
              Type.Literal("eq"),
              Type.Literal("in"),
              Type.Literal("prefix"),
              Type.Literal("contains"),
            ]),
            value: Type.Unknown(),
          }),
        ),
      ),
      any_channel: Type.Optional(
        Type.Boolean({
          description:
            "slack.app_mention only: listen in every channel the app can see, instead of a " +
            "required channel filter.",
        }),
      ),
    }),
  )({
    id: "workflows.create_trigger",
    name: "Create workflow trigger",
    description:
      "Make a workflow run automatically on matching events (event-driven only — cron " +
      "schedules are not supported yet). The event arrives in templates as " +
      "{{trigger.data.payload...}} plus {{trigger.data.key}}/{{trigger.data.refs...}}. " +
      "Returns { triggerId }.",
    // A schedule or event trigger keeps prompting the assistant after the
    // conversation ends, so a person approves it by default (risk default
    // for "high"). Agents can steer the assistant through threads.
    riskLevel: "high",
    execute: async ({ workflow_id, name, event_keys, filters, any_channel, presence }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const deps = getDeps();
      const result = await createWorkflowTrigger(
        armDepsFrom(deps),
        owner,
        { workflowId: workflow_id, name, eventKeys: event_keys, filters, anyChannel: any_channel, appearance: presence },
      );
      if (!result.ok) return { success: false, error: result.error };
      return { success: true, data: result.trigger };
    },
  });

  const listTriggers = action(
    Type.Object({ workflow_id: Type.Optional(Type.String()) }),
  )({
    id: "workflows.list_triggers",
    name: "List workflow triggers",
    description: "List event triggers targeting workflows (optionally one workflow's).",
    riskLevel: "low",
    execute: async ({ workflow_id }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const triggers = await listWorkflowTriggers(getDeps().db, owner, workflow_id);
      return { success: true, data: { triggers } };
    },
  });

  const createSchedule = action(
    Type.Object({
      workflow_id: Type.Optional(
        Type.String({ description: "Target a workflow: start a run each fire." }),
      ),
      prompt: Type.Optional(
        Type.String({
          description:
            "Target the workspace assistant instead: this prompt is delivered to you " +
            "each fire, on a dedicated thread. Provide exactly one of workflow_id or prompt.",
        }),
      ),
      name: Type.String(),
      cron: Type.String({
        description: '5-field cron expression, e.g. "0 9 * * 1-5" = 9:00 every weekday.',
      }),
      timezone: Type.Optional(
        Type.String({ description: 'IANA timezone name (default "UTC"), e.g. "America/Denver".' }),
      ),
      input: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: "Workflow target only: static payload delivered as {{trigger.data.input...}}.",
        }),
      ),
    }),
  )({
    id: "workflows.create_schedule",
    name: "Create schedule",
    description:
      "Run something on a cron schedule: a WORKFLOW (workflow_id → a run starts each fire) " +
      "or the ASSISTANT (prompt → you receive the prompt each fire, e.g. 'check my PRs " +
      "every morning'). Fires are accurate to ~30s; missed fires during downtime collapse " +
      "into one catch-up. Returns { scheduleId, nextFireAt }.",
    // A schedule or event trigger keeps prompting the assistant after the
    // conversation ends, so a person approves it by default (risk default
    // for "high"). Agents can steer the assistant through threads.
    riskLevel: "high",
    execute: async ({ workflow_id, prompt, name, cron, timezone, input }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const result = await createWorkflowSchedule(
        armDepsFrom(getDeps()),
        owner,
        {
          workflowId: workflow_id,
          prompt,
          name,
          cron,
          timezone,
          input,
          teamId: owner.principal?.type === "team" ? owner.principal.id : undefined,
        },
      );
      if (!result.ok) return { success: false, error: result.error };
      return { success: true, data: result.schedule };
    },
  });

  const proposalKeySchema = Type.Object({
    proposal_key: Type.String({ minLength: 1, maxLength: 200, description: "Stable key for this proposal. Reuse on retries; use a new key for a different proposal." }),
  });
  const proposeTrigger = action(Type.Intersect([createTrigger.parameters, proposalKeySchema]))({
    id: "workflows.propose_trigger",
    name: "Propose workflow event trigger",
    description: "Save a disabled event trigger for human review. Returns a review link and the stored configuration. Repeated keys return the existing record without changing it. Ask the user to review and turn it on in Presence.",
    riskLevel: "low",
    execute: async ({ workflow_id, name, event_keys, filters, any_channel, proposal_key, presence }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const result = await createWorkflowTrigger(armDepsFrom(getDeps()), owner, {
        workflowId: workflow_id, name, eventKeys: event_keys, filters, anyChannel: any_channel, proposalKey: proposal_key, appearance: presence,
      });
      if (!result.ok) return { success: false, error: result.error };
      return { success: true, data: proposalResult("subscription", result.trigger.triggerId, result.trigger.enabled, {
        ...result.trigger, target: { kind: "workflow", workflowId: result.trigger.workflowId,
          ...(result.trigger.appearance ? { appearance: result.trigger.appearance } : {}),
        },
      }) };
    },
  });
  const proposeSchedule = action(Type.Intersect([createSchedule.parameters, proposalKeySchema]))({
    id: "workflows.propose_schedule",
    name: "Propose schedule",
    description: "Save a disabled cron schedule for human review. Returns a review link and the stored configuration. Repeated keys return the existing record without changing it. Ask the user to review and turn it on under On a schedule in Presence.",
    riskLevel: "low",
    execute: async ({ workflow_id, prompt, name, cron, timezone, input, proposal_key }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const result = await createWorkflowSchedule(armDepsFrom(getDeps()), owner, {
        workflowId: workflow_id, prompt, name, cron, timezone, input, proposalKey: proposal_key,
        teamId: owner.principal?.type === "team" ? owner.principal.id : undefined,
      });
      if (!result.ok) return { success: false, error: result.error };
      return { success: true, data: proposalResult("schedule", result.schedule.scheduleId, result.schedule.enabled, result.schedule) };
    },
  });

  const listSchedules = action(
    Type.Object({ workflow_id: Type.Optional(Type.String()) }),
  )({
    id: "workflows.list_schedules",
    name: "List workflow schedules",
    description: "List cron schedules (optionally one workflow's) with next/last fire times.",
    riskLevel: "low",
    execute: async ({ workflow_id }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const schedules = await listWorkflowSchedules(getDeps().db, owner, workflow_id);
      return { success: true, data: { schedules } };
    },
  });

  const deleteSchedule = action(Type.Object({ schedule_id: Type.String() }))({
    id: "workflows.delete_schedule",
    name: "Delete workflow schedule",
    description: "Delete a cron schedule by id (from list_schedules/create_schedule).",
    riskLevel: "medium",
    execute: async ({ schedule_id }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const result = await deleteWorkflowSchedule(getDeps().db, owner, schedule_id);
      if (result === "not_found") return { success: false, error: `schedule not found: ${schedule_id}` };
      return { success: true, data: { scheduleId: schedule_id, deleted: true } };
    },
  });

  const deleteTrigger = action(Type.Object({ trigger_id: Type.String() }))({
    id: "workflows.delete_trigger",
    name: "Delete workflow trigger",
    description: "Delete a workflow trigger by id (from list_triggers/create_trigger).",
    riskLevel: "medium",
    execute: async ({ trigger_id }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const result = await deleteWorkflowTrigger(getDeps().db, owner, trigger_id);
      if (result === "not_found") return { success: false, error: `trigger not found: ${trigger_id}` };
      return { success: true, data: { triggerId: trigger_id, deleted: true } };
    },
  });

  const updateSchedule = action(
    Type.Object({
      schedule_id: Type.String(),
      name: Type.Optional(Type.String()),
      cron: Type.Optional(
        Type.String({
          description: '5-field cron expression, e.g. "0 9 * * 1-5". Changes recompute next fire time.',
        }),
      ),
      timezone: Type.Optional(
        Type.String({ description: 'IANA timezone name, e.g. "America/Denver". Changes recompute next fire time.' }),
      ),
      enabled: Type.Optional(
        Type.Boolean({ description: "false pauses the schedule; re-enabling recomputes next fire time." }),
      ),
      prompt: Type.Optional(Type.String({ description: "Assistant-prompt schedules only." })),
      input: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: "Workflow-target schedules only. Pass null to clear a previously set input.",
        }),
      ),
    }),
  )({
    id: "workflows.update_schedule",
    name: "Update schedule",
    description:
      "Update a cron schedule by id. Changing cron or timezone recomputes next fire time. " +
      "Setting enabled=false pauses the schedule; re-enabling recomputes next fire time so a stale slot does not fire at once. " +
      "Target kind (workflow or assistant) cannot change. Delete and recreate the schedule to switch.",
    // A schedule or event trigger keeps prompting the assistant after the
    // conversation ends, so a person approves it by default (risk default
    // for "high"). Agents can steer the assistant through threads.
    riskLevel: "high",
    execute: async ({ schedule_id, name, cron, timezone, enabled, prompt, input }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const result = await updateWorkflowSchedule(
        armDepsFrom(getDeps()),
        owner,
        schedule_id,
        { name, cron, timezone, enabled, prompt, input },
      );
      if (!result.ok) return { success: false, error: result.error };
      return { success: true, data: result.schedule };
    },
  });

  const updateTrigger = action(
    Type.Object({
      trigger_id: Type.String(),
      name: Type.Optional(Type.String()),
      event_keys: Type.Optional(
        Type.Array(Type.String(), {
          description: 'Event key patterns; trailing ".*" wildcard supported.',
        }),
      ),
      filters: Type.Optional(
        Type.Array(
          Type.Object({
            field: Type.String(),
            op: Type.Union([
              Type.Literal("eq"),
              Type.Literal("in"),
              Type.Literal("prefix"),
              Type.Literal("contains"),
            ]),
            value: Type.Unknown(),
          }),
        ),
      ),
      enabled: Type.Optional(Type.Boolean()),
      any_channel: Type.Optional(
        Type.Boolean({
          description:
            "slack.app_mention only: listen in every channel the app can see, instead of a " +
            "required channel filter.",
        }),
      ),
    }),
  )({
    id: "workflows.update_trigger",
    name: "Update event trigger",
    description:
      "Update a workflow event trigger by id. All fields are optional; only supplied fields change. " +
      "Changing event_keys or filters re-validates against the event catalog.",
    // A schedule or event trigger keeps prompting the assistant after the
    // conversation ends, so a person approves it by default (risk default
    // for "high"). Agents can steer the assistant through threads.
    riskLevel: "high",
    execute: async ({ trigger_id, name, event_keys, filters, enabled, any_channel }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const deps = getDeps();
      const result = await updateWorkflowTrigger(
        armDepsFrom(deps),
        owner,
        trigger_id,
        { name, eventKeys: event_keys, filters, enabled, anyChannel: any_channel },
      );
      if (!result.ok) return { success: false, error: result.error };
      return { success: true, data: result.trigger };
    },
  });

  const createWebhook = action(Type.Object({ workflow_id: Type.String() }))({
    id: "workflows.create_webhook",
    name: "Create or rotate workflow webhook",
    description:
      "Mint an arbitrary-URL trigger for a workflow: POST any JSON to the returned URL and a run " +
      "starts, no Valet auth required — the URL itself is the credential. Calling this again on the " +
      "same workflow ROTATES the secret: the old URL stops working immediately. Returns { workflowId, " +
      "hookId, url }.",
    // high, not medium: this mints a bearer secret that is the ENTIRE auth
    // for triggering a run — equivalent in blast radius to granting a new
    // credential, which the plugin catalog's default policy (medium ==
    // auto-allow) would otherwise let the agent do with no human in the
    // loop.
    riskLevel: "high",
    execute: async ({ workflow_id }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const result = await mintOrRotateWorkflowWebhook(getDeps().db, owner, workflow_id);
      if (!result.ok) return { success: false, error: result.error };
      return {
        success: true,
        data: { ...result.webhook, url: workflowWebhookUrl(result.webhook.workflowId, result.webhook.hookId) },
      };
    },
  });

  const getWebhook = action(Type.Object({ workflow_id: Type.String() }))({
    id: "workflows.get_webhook",
    name: "Get workflow webhook",
    description: "Look up the current webhook URL for a workflow, or null if none has been minted.",
    riskLevel: "low",
    execute: async ({ workflow_id }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const result = await getWorkflowWebhook(getDeps().db, owner, workflow_id);
      if (!result.ok) return { success: false, error: result.error };
      if (!result.webhook) return { success: true, data: { webhook: null } };
      return {
        success: true,
        data: { webhook: { ...result.webhook, url: workflowWebhookUrl(result.webhook.workflowId, result.webhook.hookId) } },
      };
    },
  });

  const deleteWebhook = action(Type.Object({ workflow_id: Type.String() }))({
    id: "workflows.delete_webhook",
    name: "Delete workflow webhook",
    description: "Remove a workflow's webhook trigger, if any. The URL 404s afterward.",
    riskLevel: "medium",
    execute: async ({ workflow_id }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const result = await deleteWorkflowWebhook(getDeps().db, owner, workflow_id);
      if (result === "not_found") return { success: false, error: `workflow not found: ${workflow_id}` };
      return { success: true, data: { workflowId: workflow_id, deleted: result === "deleted" } };
    },
  });

  return {
    service: "workflows",
    description:
      "Create, inspect, and run Valet DAG workflows (dag/v1 definitions: nodes + edges).",
    actions: [
      copyToTeam,
      listWorkflows,
      getWorkflow,
      getPermissions,
      saveWorkflow,
      patchWorkflow,
      updateModel,
      addAggregate,
      deleteWorkflow,
      requestWorkflowDeletion,
      startRun,
      getRun,
      getNodeResult,
      getNodeDiagnostics,
      getNodeTranscript,
      previewWorkflowAction,
      listRuns,
      cancelRun,
      retryRun,
      allowPermissions,
      resolveApproval,
      listEventTypesAction,
      createTrigger,
      proposeTrigger,
      listTriggers,
      deleteTrigger,
      updateTrigger,
      createSchedule,
      proposeSchedule,
      listSchedules,
      deleteSchedule,
      updateSchedule,
      createWebhook,
      getWebhook,
      deleteWebhook,
    ],
  };
}

/** Messages per `get_node_transcript` page, and the most a caller may ask for. */
const TRANSCRIPT_PAGE = 20;
const TRANSCRIPT_PAGE_MAX = 50;

/** The most one `get_node_result` checkpoint holds, and the most one whole
 * `preview_workflow` reply holds. */
const TOOL_RESULT_CHARS = 20_000;

/** The least room one preview value keeps, however many values share the budget. */
const PREVIEW_VALUE_MIN_CHARS = 200;

const PREVIEW_CUT_NOTE =
  "Cut to fit the tool result. Pass node_id to preview one step with more room, " +
  "or call get_node_result for the full result of a step in the sample run.";

/**
 * Return a checkpoint result verbatim when its JSON fits `maxChars`, so the
 * agent sees the same structured value templates read via
 * `nodes.<id>.result`. An oversized result becomes a `{ truncated: true,
 * jsonPrefix }` stub so a giant payload can't blow up the LLM context.
 * `note`, when given, goes on the stub and tells the agent where to read more.
 * (An earlier always-stringified wrapper here read as the checkpoint's own
 * shape and convinced agents the data was unreachable.)
 */
function presentResult(value: unknown, maxChars: number, note?: string): unknown {
  let json: string;
  try {
    json = JSON.stringify(value) ?? "null";
  } catch (err) {
    json = `<unserializable: ${err instanceof Error ? err.message : String(err)}>`;
    return { truncated: true, jsonPrefix: json, ...(note ? { note } : {}) };
  }
  if (json.length <= maxChars) return value;
  return { truncated: true, jsonPrefix: json.slice(0, maxChars), ...(note ? { note } : {}) };
}

/**
 * Fit a preview into one tool result. A preview repeats sample values: a
 * step's output, its observed example, and each downstream field that reads
 * it. So one 200,000-character checkpoint made a 1,000,000-character result.
 * The values share half of `maxChars`, and {@link presentResult} cuts each
 * value that is longer than its share. A reply whose encoded form still
 * does not fit is cut as a whole. The HTTP route gives the editor the full
 * preview.
 */
function presentPreview(workflowId: string, response: PreviewWorkflowResponse, maxChars: number): unknown {
  const valueCount = response.nodes.reduce(
    (count, node) =>
      count + node.fields.length + (node.output === undefined ? 0 : 1) + (node.outputShape.example === undefined ? 0 : 1),
    0,
  );
  const valueChars = Math.max(PREVIEW_VALUE_MIN_CHARS, Math.floor(maxChars / 2 / Math.max(valueCount, 1)));
  const cut = (value: unknown): unknown => presentResult(value, valueChars, PREVIEW_CUT_NOTE);
  const nodes = response.nodes.map((node) => ({
    ...node,
    fields: node.fields.map((field) => ({ ...field, resolved: cut(field.resolved) })),
    ...(node.output === undefined ? {} : { output: cut(node.output) }),
    outputShape: node.outputShape.example === undefined
      ? node.outputShape
      : { ...node.outputShape, example: cut(node.outputShape.example) },
  }));
  const presented = { workflowId, ...response, nodes };
  // Measure what the model reads. The engine encodes the result with
  // encodeToolOutput, which indents each nested level, so a deep value
  // encodes to many times its compact JSON.
  if (encodeToolOutput(presented).length <= maxChars) return presented;
  // The encoder quotes the JSON prefix and escapes its quotes again, and the
  // stub adds its keys and note. Drop the overflow from the prefix until the
  // encoded stub fits.
  const json = JSON.stringify(presented);
  for (let prefixChars = Math.floor(maxChars / 2); ; ) {
    const stub = { truncated: true, jsonPrefix: json.slice(0, prefixChars), note: PREVIEW_CUT_NOTE };
    const overflow = encodeToolOutput(stub).length - maxChars;
    if (overflow <= 0 || prefixChars === 0) return stub;
    prefixChars = Math.max(0, prefixChars - overflow);
  }
}
