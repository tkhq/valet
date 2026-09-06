/**
 * Whether a team-owned workflow can act as each service its tool nodes name.
 *
 * A scheduled or event-fired team run bills the team, not the person who
 * armed it. The per-user Integrations list is therefore the wrong gate: a
 * member's own Gmail connection does not fund a team run, and an org Slack
 * bot the member never connected does. This predicate is the one answer
 * every install and arm path must use (team-credentials design, decision 15).
 *
 * A service is ready when any of three conditions holds:
 *
 *   1. The team has a credential row for it, direct or delegated.
 *   2. The service is in `orgProvidedServiceSet` (an org-mode connection
 *      every member already rides).
 *   3. Every tool node naming that service pins `credential: "app"` and
 *      `loadAppConfig` reports a configured GitHub App.
 *
 * A blocked service carries the reason so the caller can name the fix.
 */
import type { CredentialStore, ValetPlugin } from "@valet/engine";
import type { ToolNode, WorkflowDefinition } from "@valet/workflow";
import type { AppDb } from "../lib/drizzle.js";
import { loadAppConfig } from "../services/github-app.js";
import { orgProvidedServiceSet } from "../services/integration-availability.js";

export interface TeamServiceReadinessDeps {
  db: AppDb;
  credentials: CredentialStore;
  plugins: ValetPlugin[];
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

/** Tool nodes anywhere in the definition, including a foreach body. Kept
 * here so this module does not import `templates.ts` (that file calls us). */
function toolNodesOf(definition: WorkflowDefinition): ToolNode[] {
  const out: ToolNode[] = [];
  for (const node of definition.nodes) {
    if (node.type === "tool") out.push(node);
    else if (node.type === "foreach" && node.body.type === "tool") out.push(node.body);
  }
  return out;
}

export async function teamServiceReadiness(
  deps: TeamServiceReadinessDeps,
  opts: { orgId: string; teamId: string; definition: WorkflowDefinition },
): Promise<TeamServiceReadiness> {
  const nodes = toolNodesOf(opts.definition);
  const services = [...new Set(nodes.map((node) => node.service))];
  if (services.length === 0) return { ready: [], blocked: [] };

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
    if (teamServices.has(service)) {
      ready.push(service);
      continue;
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
    blocked.push({
      service,
      reason: `Connect ${service} for this team, then install this template.`,
    });
  }
  return { ready, blocked };
}
