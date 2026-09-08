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
 *      a secret, or a delegated reference whose delegator is still on the
 *      team and still connected. `credentials.list` returns a reference row
 *      after either lapses, so each hit is read back the way a run reads it.
 *   3. The service is in `orgProvidedServiceSet` (an org-mode connection
 *      every member already rides).
 *   4. Every tool node naming that service pins `credential: "app"` and
 *      `loadAppConfig` reports a configured GitHub App.
 *   5. An org-scoped 1Password item resolves for the service. A team run
 *      that finds no row falls through to `lookupInOnePassword` on the org
 *      scope (`services/credential-resolution.ts#resolveTeamCredentialRead`),
 *      so the same lookup answers here, and only when a 1Password client is
 *      configured. The personal scope is never consulted: a team run has no
 *      actor whose vault it may borrow (`onePasswordScopesFor("team")`).
 *
 * Before condition 5 the predicate asks `connectModeFor` with the
 * team as owner, as the invoker does before it reads a credential. A
 * service whose org prerequisite is missing is blocked with the admin fix,
 * whatever the vault holds: the run would refuse it on every fire.
 *
 * A blocked service carries the reason so the caller can name the fix.
 * Every reason is caller-neutral and ends with a period: the install path
 * and the repository sync both read this predicate, and each adds the step
 * that follows the fix in its own flow (install the template, or wait for
 * the next sync). A reason that named one flow's next step would misdirect
 * the reader of the other.
 */
import type { CredentialStore, ValetPlugin } from "@valet/engine";
import type { WorkflowDefinition } from "@valet/workflow";
import type { AppDb } from "../lib/drizzle.js";
import { CredentialReferenceBrokenError, TeamCredentialStore } from "../plugins/team-credential-store.js";
import { lookupInOnePassword, onePasswordScopesFor } from "../services/credential-resolution.js";
import { loadAppConfig } from "../services/github-app.js";
import type { OnePasswordService } from "../services/onepassword.js";
import { connectModeFor, findCredentialDeclaration, orgProvidedServiceSet } from "../services/integration-availability.js";
import { isTeamMember } from "../services/teams.js";
import { toolNodesOf } from "./tool-nodes.js";

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

export interface TeamServiceReadiness {
  ready: string[];
  blocked: BlockedTeamService[];
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
 * the source row. `empty` is a stub with no secret and no delegation, which
 * gates like no row at all so an org-provided service is not blocked by it.
 */
type TeamRowState = "resolves" | "broken" | "empty";

async function teamRowState(
  store: TeamCredentialStore,
  teamId: string,
  service: string,
): Promise<TeamRowState> {
  try {
    const row = await store.get({ type: "team", id: teamId }, service);
    return row === null ? "empty" : "resolves";
  } catch (err) {
    if (err instanceof CredentialReferenceBrokenError) return "broken";
    throw err;
  }
}

export async function teamServiceReadiness(
  deps: TeamServiceReadinessDeps,
  opts: { orgId: string; teamId: string; definition: WorkflowDefinition },
): Promise<TeamServiceReadiness> {
  const nodes = toolNodesOf(opts.definition);
  const services = [...new Set(nodes.map((node) => node.service))];
  if (services.length === 0) return { ready: [], blocked: [] };
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
      const state = await teamRowState(store, opts.teamId, service);
      if (state === "resolves") {
        ready.push(service);
        continue;
      }
      if (state === "broken") {
        blocked.push({
          service,
          reason:
            `${service} was shared by a member who is no longer on the team, or whose connection is gone. ` +
            `Share it again, or store a team credential.`,
        });
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
      reason: `Connect ${service} for this team.`,
    });
  }
  return { ready, blocked };
}
