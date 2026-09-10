/**
 * Whether a team-owned workflow can act as each service its tool nodes name.
 *
 * A scheduled or event-fired team run bills the team, not the person who
 * armed it. The per-user Integrations list is therefore the wrong gate: a
 * member's own Gmail connection does not fund a team run, and an org Slack
 * bot the member never connected does. This predicate is the one answer
 * every install and arm path must use (team-credentials design, decision 15).
 *
 * A service is ready when any of five conditions holds:
 *
 *   1. No plugin in the registry declares a credential for it, so its
 *      actions need nothing connected (the workflows plugin's own actions).
 *      The declaration can live on a different plugin than the action's
 *      owner, so the read is registry-wide, as in
 *      `plugins/action-invoker.ts`.
 *   2. The team has a credential row for it that resolves: a direct row with
 *      a secret, a delegated reference whose delegator is still on the
 *      team and still connected, or a 1Password reference inside the
 *      team's lease that a configured client turns into a secret.
 *      `credentials.list` returns a row after any of those lapses, so each
 *      hit is read back the way a run reads it
 *      (`services/credential-resolution.ts#resolveTeamCredentialRead`,
 *      stopped at the team row).
 *   3. The service is in `orgProvidedServiceSet` (an org-mode connection
 *      every member already rides).
 *   4. Every tool node naming that service pins `credential: "app"` and
 *      `loadAppConfig` reports a configured GitHub App.
 *   5. Every unpinned github node (no `credential`, or `"auto"`) has an App
 *      installation to act through: the one for the node's literal `owner`
 *      parameter, or the org's sole one
 *      (`services/github-tokens.ts#installationResolvesFor`). This is the
 *      team branch of the invoker's github provider, which tries the team
 *      row first and then the installation. A `"user"` pin stays on the
 *      team row: it never reaches an installation.
 *   6. An org-scoped 1Password item resolves for the service. A team run
 *      that finds no row falls through to `lookupInOnePassword` on the org
 *      scope (`services/credential-resolution.ts#resolveTeamCredentialRead`),
 *      so the same lookup answers here, and only when a 1Password client is
 *      configured. The personal scope is never consulted: a team run has no
 *      actor whose vault it may borrow (`onePasswordScopesFor("team")`).
 *
 * Before condition 6 the predicate asks `connectModeFor` with the
 * team as owner, as the invoker does before it reads a credential. A
 * service whose org prerequisite is missing is blocked with the admin fix,
 * whatever the vault holds: the run would refuse it on every fire.
 *
 * The nodes judged are the whole closure, not the definition's own: a
 * `workflow` node runs the callee's nodes as this same team. A callee the
 * team cannot read is reported as unverifiable rather than passed, because
 * the run fails at the call node for the same reason.
 *
 * A blocked service carries the reason so the caller can name the fix.
 * Every reason is caller-neutral and ends with a period: the install path
 * and the repository sync both read this predicate, and each adds the step
 * that follows the fix in its own flow (install the template, or wait for
 * the next sync). A reason that named one flow's next step would misdirect
 * the reader of the other.
 */
import type { CredentialStore, StoredCredential, ValetPlugin } from "@valet/engine";
import type { ToolNode, WorkflowDefinition } from "@valet/workflow";
import { and, eq } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { workflowDefinitions } from "../schema/index.js";
import { credentialSecret } from "@valet/engine";
import { CredentialReferenceBrokenError, TeamCredentialStore } from "../plugins/team-credential-store.js";
import {
  lookupInOnePassword,
  onePasswordScopesFor,
  resolveTeamCredentialRead,
} from "../services/credential-resolution.js";
import { loadAppConfig } from "../services/github-app.js";
import { installationResolvesFor, isUsableGithubUserRow } from "../services/github-tokens.js";
import { OnePasswordAuthError, type OnePasswordService } from "../services/onepassword.js";
import { connectModeFor, findCredentialDeclaration, orgProvidedServiceSet } from "../services/integration-availability.js";
import { isTeamMember } from "../services/teams.js";
import { toolNodeClosure } from "./tool-nodes.js";

export interface TeamServiceReadinessDeps {
  db: AppDb;
  credentials: CredentialStore;
  plugins: ValetPlugin[];
  /** The 1Password client a run resolves through. Absent when the
   * deployment has none; the vault condition then never holds. */
  onePassword?: OnePasswordService;
  env?: NodeJS.ProcessEnv;
}

export interface BlockedTeamService {
  service: string;
  reason: string;
}

/**
 * A `workflow` call whose callee this team cannot read. The tool nodes
 * behind it are unverifiable, and the run fails at the call node for the
 * same reason, so it refuses an install or an arm the way a blocked
 * service does.
 */
export interface UnverifiableWorkflowCall {
  workflowId: string;
  reason: string;
}

export interface TeamServiceReadiness {
  ready: string[];
  blocked: BlockedTeamService[];
  unverifiable: UnverifiableWorkflowCall[];
}

export interface TeamReadinessRefusal {
  /** The tool service, when a service is what the team cannot act as.
   * Absent for a call whose definition the gate could not read. */
  service?: string;
  reason: string;
}

/**
 * Every reason a team may not run this definition, blocked services and
 * unreadable calls together. One reader, so a gate cannot answer on the
 * services and silently forget the calls.
 */
export function teamArmRefusals(readiness: TeamServiceReadiness): TeamReadinessRefusal[] {
  return [
    ...readiness.blocked.map((entry) => ({ service: entry.service, reason: entry.reason })),
    ...readiness.unverifiable.map((entry) => ({ reason: entry.reason })),
  ];
}

/** A caller-neutral readiness reason with the calling flow's next step
 * appended, so the reader is told what to do after the fix. */
export function withNextStep(reason: string, step: string): string {
  return reason.endsWith(".") ? `${reason.slice(0, -1)}, then ${step}.` : `${reason} Then ${step}.`;
}

/**
 * Why a team may not arm a schedule or a trigger over this definition, or
 * null when it may. `step` is the step that follows the fix in the calling
 * flow, for example "create the schedule".
 *
 * Schedule and workflow-trigger creation share the readiness predicate
 * used by template install and repository sync.
 */
export async function teamArmBlock(
  deps: TeamServiceReadinessDeps,
  opts: { orgId: string; teamId: string; definition: WorkflowDefinition; step: string },
): Promise<string | null> {
  const refusals = teamArmRefusals(await teamServiceReadiness(deps, opts));
  if (refusals.length === 0) return null;
  return refusals.map((refusal) => withNextStep(refusal.reason, opts.step)).join(" ");
}

/**
 * The callee lookup a `workflow` node makes, as the run makes it:
 * `engine-deps.ts#resolveWorkflow` matches the run owner's
 * `{ownerType, ownerId}` exactly and answers null on a mismatch, the same
 * as for a missing id.
 */
function teamWorkflowResolver(
  db: AppDb,
  teamId: string,
  definitions?: ReadonlyMap<string, WorkflowDefinition | null>,
) {
  return async (workflowId: string): Promise<WorkflowDefinition | null> => {
    const rows = await db
      .select({ definition: workflowDefinitions.definition })
      .from(workflowDefinitions)
      .where(
        and(
          eq(workflowDefinitions.id, workflowId),
          eq(workflowDefinitions.ownerType, "team"),
          eq(workflowDefinitions.ownerId, teamId),
        ),
      )
      .limit(1);
    const row = rows[0];
    // The column is jsonb, so drizzle types it `unknown`. The dag validator
    // ran before any definition reached the row.
    if (!row) return null;
    if (definitions?.has(workflowId)) return definitions.get(workflowId) ?? null;
    return row.definition as WorkflowDefinition;
  };
}

/**
 * Tool services whose actions need no credential: no plugin in the registry
 * declares one for the service's credential key, and no action plugin says
 * otherwise. An action plugin's `requiresCredential` outranks the
 * declaration lookup, as in `workflows/templates.ts#credentialServiceFor`.
 * A service no plugin ships stays out of the set, so it is still gated.
 * When two plugins ship actions for one service, a required answer from
 * either keeps it gated.
 */
function credentialFreeServices(plugins: ValetPlugin[]): Set<string> {
  const required = new Map<string, boolean>();
  for (const plugin of plugins) {
    for (const actionPlugin of plugin.actions ?? []) {
      const key = actionPlugin.credentialService ?? actionPlugin.service;
      const needs = actionPlugin.requiresCredential ?? findCredentialDeclaration(plugins, key) !== null;
      required.set(actionPlugin.service, (required.get(actionPlugin.service) ?? false) || needs);
    }
  }
  return new Set([...required].filter(([, needs]) => !needs).map(([service]) => service));
}

/**
 * What a listed team row is worth. `resolves` is a row a run can use.
 * `broken` is a delegated reference whose delegator left the team or lost
 * the source row. `refused` is a row the run's read rejects with a typed
 * message: a 1Password reference outside the team's lease, or one no
 * client can dereference. `empty` is a stub with no secret and no
 * delegation, which gates like no row at all so an org-provided service is
 * not blocked by it.
 */
type TeamRowState = { kind: "resolves" } | { kind: "broken" } | { kind: "refused"; reason: string } | { kind: "empty" };

/**
 * The row read the way a team run reads it, stopped at the team row
 * (`orgFallback: "none"`): the org-provided fallback and the vault search
 * are separate conditions below, each with its own reason. The lease and
 * the scope rule apply here as they do on the run, so a reference the run
 * would refuse on every fire is blocked with the message the run gives.
 */
async function teamRowState(
  deps: { credentials: TeamCredentialStore; onePassword?: OnePasswordService },
  orgId: string,
  teamId: string,
  service: string,
): Promise<TeamRowState> {
  let row: StoredCredential | null;
  try {
    row = await resolveTeamCredentialRead(
      deps,
      { orgId, teamId, userId: "", scopes: onePasswordScopesFor("team") },
      service,
      "none",
    );
  } catch (err) {
    if (err instanceof CredentialReferenceBrokenError) return { kind: "broken" };
    // A lease or scope refusal, a missing or disabled token: the run gives
    // the same answer on every fire, so the trigger stays off with that
    // message. An SDK or network failure is transient and must not disarm
    // anything: it propagates so the sync defers the file to its next pass.
    if (err instanceof OnePasswordAuthError && err.kind !== "sdk") return { kind: "refused", reason: err.message };
    throw err;
  }
  if (row === null) return { kind: "empty" };
  // A github row the run would refuse (identity-only sign-in scopes, a
  // failed refresh, an expired token with no refresh token) reads as no
  // row, the way the invoker's team branch skips it and falls to the App.
  if (service === "github" && !isUsableGithubUserRow(row, Date.now())) return { kind: "empty" };
  if (credentialSecret(row) !== undefined) return { kind: "resolves" };
  // A reference passes through the read unchanged when no client is wired
  // (`resolveRow`), and the run then treats the empty secret as no
  // credential. Name the actual gap instead of the generic "connect" hint.
  return {
    kind: "refused",
    reason:
      `${service} is stored as a 1Password reference, but this deployment has no 1Password client configured. ` +
      `Connect a service account token in Settings → Organization, or store the secret directly for the team.`,
  };
}

/**
 * The `owner` a github node's App installation is looked up under, as
 * `plugins/action-invoker.ts#repoFromParams` reads it: both `owner` and
 * `repo` present and non-empty. A templated owner is known only at fire
 * time, so it is treated as absent and the sole-installation rule decides.
 */
function literalRepoOwner(params: Record<string, unknown>): string | undefined {
  const owner = params.owner;
  const name = params.repo;
  if (typeof owner !== "string" || owner.length === 0 || owner.includes("{{")) return undefined;
  if (typeof name !== "string" || name.length === 0) return undefined;
  return owner;
}

/**
 * Condition 5 for the github nodes that leave `credential` unset or
 * `"auto"`: ready when every one of them has an installation to act
 * through. Otherwise the first node without one decides. An App that is
 * present but cannot pick an installation for the node gets a reason that
 * names the mismatch; no App, or an App with no installation recorded yet
 * (the table fills on the first run or on "Refresh installations"), is
 * the plain "connect" state and carries no reason of its own. A `"user"`
 * pin is not answered here, so the caller keeps looking.
 */
async function unpinnedGithubGate(
  deps: TeamServiceReadinessDeps,
  orgId: string,
  nodes: ToolNode[],
): Promise<{ ready: true } | { ready: false; reason?: string }> {
  const env = deps.env ?? process.env;
  for (const node of nodes) {
    const owner = literalRepoOwner(node.params);
    const resolution = await installationResolvesFor({ db: deps.db, credentials: deps.credentials, env }, orgId, owner);
    if (resolution.ok) continue;
    switch (resolution.gap) {
      case "no_app":
      case "no_installations":
        return { ready: false };
      case "no_installation_for_owner":
        return {
          ready: false,
          reason:
            `github has no App installation for ${resolution.owner}. Install the App on ${resolution.owner} in ` +
            "Settings → Organization → GitHub, or store a github credential for the team.",
        };
      case "ambiguous":
        return {
          ready: false,
          reason:
            `github resolves through the GitHub App, and this organization has ${resolution.count} installations, ` +
            `so none is chosen for a node that names no repository owner. Add "owner" and "repo" parameters to the tool node, ` +
            "or install the App on exactly one account.",
        };
    }
  }
  return { ready: true };
}

export async function teamServiceReadiness(
  deps: TeamServiceReadinessDeps,
  opts: {
    orgId: string;
    teamId: string;
    definition: WorkflowDefinition;
    /** Sync-local definitions by ID. Exact owner authorization still uses the database. */
    definitions?: ReadonlyMap<string, WorkflowDefinition | null>;
  },
): Promise<TeamServiceReadiness> {
  // A `workflow` node runs the callee's nodes as this same team, so its
  // tool nodes are this team's to fund (TKAI-443).
  const closure = await toolNodeClosure(opts.definition, teamWorkflowResolver(deps.db, opts.teamId, opts.definitions));
  const nodes = closure.nodes;
  const unverifiable: UnverifiableWorkflowCall[] = closure.unresolved.map((workflowId) => ({
    workflowId,
    reason:
      `This workflow calls workflow ${JSON.stringify(workflowId)}, which does not exist or belongs to ` +
      `another owner, so the call fails on every run. Reference a workflow this team owns, or remove the call.`,
  }));
  const services = [...new Set(nodes.map((node) => node.service))];
  if (services.length === 0) return { ready: [], blocked: [], unverifiable };
  const credentialFree = credentialFreeServices(deps.plugins);

  // A team row is read through the same decorator a run resolves it with,
  // so a delegated reference counts only while it still follows to a live
  // member's row. Wrapping a store that already follows references is a
  // no-op: the inner store returns the source row, and the outer keeps it.
  const store = new TeamCredentialStore(deps.credentials, {
    isMember: (teamId, userId) => isTeamMember(deps.db, teamId, userId),
  });

  const env = deps.env ?? process.env;
  const [teamRows, orgProvided] = await Promise.all([
    deps.credentials.list({ type: "team", id: opts.teamId }),
    orgProvidedServiceSet({
      plugins: deps.plugins,
      orgId: opts.orgId,
      credentials: deps.credentials,
      env,
    }),
  ]);
  const teamServices = new Set(teamRows.map((row) => row.service));

  const ready: string[] = [];
  const blocked: BlockedTeamService[] = [];
  for (const service of services) {
    if (credentialFree.has(service)) {
      ready.push(service);
      continue;
    }
    if (teamServices.has(service)) {
      const state = await teamRowState(
        { credentials: store, onePassword: deps.onePassword },
        opts.orgId,
        opts.teamId,
        service,
      );
      if (state.kind === "resolves") {
        ready.push(service);
        continue;
      }
      if (state.kind === "broken") {
        blocked.push({
          service,
          reason:
            `${service} was shared by a member who is no longer on the team, or whose connection is gone. ` +
            `Share it again, or store a team credential.`,
        });
        continue;
      }
      if (state.kind === "refused") {
        blocked.push({ service, reason: state.reason });
        continue;
      }
    }
    if (orgProvided.has(service)) {
      ready.push(service);
      continue;
    }
    const forService = nodes.filter((node) => node.service === service);
    const allApp = forService.length > 0 && forService.every((node) => node.credential === "app");
    if (allApp) {
      const app = await loadAppConfig({ credentials: deps.credentials, env }, opts.orgId);
      if (app) {
        ready.push(service);
        continue;
      }
      blocked.push({
        service,
        reason:
          `${service} pins the GitHub App, but this organization has no App configured. ` +
          `An admin sets it up in Settings → Organization.`,
      });
      continue;
    }
    // Condition 5. Only github reaches an installation: the invoker routes
    // every other service to the plain row read. A node pinned `"user"`
    // keeps the service on the row-and-vault path below, where its answer
    // is. The gap is held rather than reported: a vault item titled
    // `github` still answers an unpinned node, as it does on the run.
    let unpinnedReason: string | undefined;
    if (service === "github") {
      const unpinned = forService.filter((node) => node.credential === undefined || node.credential === "auto");
      const userPinned = forService.some((node) => node.credential === "user");
      const gate = unpinned.length > 0 ? await unpinnedGithubGate(deps, opts.orgId, unpinned) : { ready: true as const };
      if (gate.ready && !userPinned) {
        ready.push(service);
        continue;
      }
      if (!gate.ready) unpinnedReason = gate.reason;
    }
    // The invoker refuses a service whose org prerequisite is missing
    // before it reads any credential (`plugins/action-invoker.ts`), so a
    // vault item must not arm what the run would refuse. Asked with the
    // team as owner, the same way the run asks, so a team row still counts.
    const declared = findCredentialDeclaration(deps.plugins, service);
    if (declared) {
      const mode = await connectModeFor({
        plugins: deps.plugins,
        decl: declared,
        service,
        orgId: opts.orgId,
        credentials: deps.credentials,
        env,
        owner: { type: "team", id: opts.teamId },
      });
      if (mode === "unconfigured") {
        blocked.push({
          service,
          reason: `${service} is not configured for this organization. An admin can set it up in Settings → Organization.`,
        });
        continue;
      }
    }
    // The vault last, as the run reads it: after the team row and the
    // org-provided fallback, and never for an App pin, which uses no
    // credential row at all. `userId` is empty for the same reason the
    // run's is: no member is the actor of a team run.
    if (deps.onePassword) {
      const fromVault = await lookupInOnePassword(
        { credentials: deps.credentials, onePassword: deps.onePassword },
        { orgId: opts.orgId, userId: "", scopes: onePasswordScopesFor("team") },
        service,
      );
      if (fromVault) {
        ready.push(service);
        continue;
      }
    }
    blocked.push({
      service,
      reason: unpinnedReason ?? `Connect ${service} for this team.`,
    });
  }
  return { ready, blocked, unverifiable };
}
