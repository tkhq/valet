import type { CredentialStore } from "@valet/engine";
import { isAgentCaller, type AuthVia, type RequestPrincipal } from "../lib/request-principal.js";
import type { WorkflowOwner, WorkflowServiceDeps } from "./service.js";

/**
 * The workflow service's dependencies and caller for one request. The
 * workflow routes and the step-log read in `routes/messages.ts` build them
 * here, so both apply the same run access rules.
 */
export function workflowRequestContext(c: {
  var: {
    providers: Omit<WorkflowServiceDeps, "credentials"> & { engineCredentials: CredentialStore };
    user: { id: string; orgId: string };
    principal?: RequestPrincipal;
    authVia?: AuthVia;
  };
}): { deps: WorkflowServiceDeps; owner: WorkflowOwner } {
  const { db, workflowStore, workflowRunHost, actionPluginByService, engineCredentials, engineStore } =
    c.var.providers;
  return {
    // `engineStore` is what run-origin validation probes for the origin
    // thread (`activeWorkflowOrigin`).
    deps: { db, workflowStore, workflowRunHost, actionPluginByService, credentials: engineCredentials, engineStore },
    owner: {
      userId: c.var.principal?.type === "team" ? `team:${c.var.principal.id}` : c.var.user.id,
      orgId: c.var.user.orgId,
      principal: c.var.principal,
      humanAccountConsent: c.var.principal?.type === "user" && (c.var.authVia === "session" || c.var.authVia === "stub"),
      // An MCP app or a `valet login` CLI: a step change revokes grants.
      agentEditor: c.var.authVia !== undefined && isAgentCaller(c.var.authVia),
    },
  };
}
