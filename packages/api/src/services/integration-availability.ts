/**
 * Service availability — the one definition of "can anyone in this org
 * connect this service right now" (integration-availability design,
 * docs/specs/2026-08-17-integration-availability-design.md).
 *
 * A credential declaration is offered when at least one of its connect
 * paths is executable in this deployment:
 *
 *   1. `oauth.mode === "mcp"`             → "oauth" (the remote server owns
 *      the dance; nothing to configure locally).
 *   2. authorization_code + client env    → "oauth".
 *   3. authorization_code, env missing    → "unconfigured". No manual
 *      fallback: a pasted access token cannot refresh without the client
 *      secret, so token entry can never produce a working credential.
 *   4. `requires.orgCredential` unmet     → "unconfigured". The org-scoped
 *      credential (an admin connects it in Settings → Organization) is the
 *      integration's foundation — e.g. the Slack app.
 *   5. otherwise                          → "manual". A self-sufficient
 *      personal token (API key), always offered.
 *
 * Four consumers share this definition: `/api/plugins` (presentation),
 * `PUT /api/credentials/:service` (manual-save gate), `EngineHost.
 * sessionExtras` (agent tool gate), and the workflow `ActionInvoker`.
 * Availability gates NEW connections and tool exposure only — stored
 * credentials stay readable and deletable regardless.
 */
import type {
  ActionPlugin,
  CredentialDeclaration,
  CredentialStore,
  ValetPlugin,
} from "@valet/engine";
import { authCodeEnvReady, findOAuthDeclaration } from "./integration-oauth.js";

export type ConnectMode = "oauth" | "manual" | "unconfigured";

export interface AvailabilityContext {
  plugins: ValetPlugin[];
  orgId: string;
  credentials: CredentialStore;
  env: Record<string, string | undefined>;
}

/** Resolves one declaration to the connect affordance the org gets. */
export async function connectModeFor(
  params: AvailabilityContext & { decl: CredentialDeclaration; service: string },
): Promise<ConnectMode> {
  const found = findOAuthDeclaration(params.plugins, params.service);
  if (found !== null) {
    if (found.oauth.mode === "mcp") return "oauth";
    return authCodeEnvReady(found.oauth, params.env) ? "oauth" : "unconfigured";
  }
  if (params.decl.requires?.orgCredential) {
    const orgCredential = await params.credentials.get(
      { type: "org", id: params.orgId },
      params.service,
    );
    if (orgCredential === null) return "unconfigured";
  }
  return "manual";
}

/**
 * The declared services that resolve "unconfigured" for this org — the set
 * the session-build and workflow gates strip tools by. Keys are declaration
 * services (`decl.service ?? plugin.name`), the same key the credential
 * store and `gateUnavailableActions`'s join use.
 */
export async function unavailableServiceSet(params: AvailabilityContext): Promise<Set<string>> {
  const unavailable = new Set<string>();
  await Promise.all(
    params.plugins.flatMap((plugin) =>
      (plugin.credentials ?? []).map(async (decl) => {
        const service = decl.service ?? plugin.name;
        const mode = await connectModeFor({ ...params, decl, service });
        if (mode === "unconfigured") unavailable.add(service);
      }),
    ),
  );
  return unavailable;
}

/**
 * Strips the `ActionPlugin`s whose credential key (`credentialService ??
 * service` — the same join `invokeAction` and the `/api/plugins` actions
 * column use) belongs to an unavailable service. Everything else on the
 * plugin — credentials, skills, roles, triggers, transports — stays:
 * webhook ingress already fails closed without its org secret, and the
 * credential declaration must stay listed so the connect UI can report
 * "unconfigured" and a leftover credential stays disconnectable.
 */
export function gateUnavailableActions(
  plugins: ValetPlugin[],
  unavailable: ReadonlySet<string>,
): ValetPlugin[] {
  if (unavailable.size === 0) return plugins;
  return plugins.map((plugin) => {
    const actions = plugin.actions ?? [];
    const kept = actions.filter(
      (actionPlugin: ActionPlugin) =>
        !unavailable.has(actionPlugin.credentialService ?? actionPlugin.service),
    );
    if (kept.length === actions.length) return plugin;
    return { ...plugin, actions: kept };
  });
}
