import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env.js";
import { bestEffortTelemetry, externalCallOwner, externalWorkflowOwner, recordExternalCall } from "../services/external-usage.js";

/** Headers identify an invocation, never authority. Auth supplies the user and org. */
export function cliUsage(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.req.path === "/api/health") { await next(); return; }
    const started = Date.now();
    await next();
    const id = c.req.header("x-valet-cli-invocation");
    const name = c.req.header("x-valet-cli-command");
    const version = c.req.header("x-valet-cli-version");
    if (!c.var.user || !id || !/^[0-9a-f-]{36}$/.test(id) || !name || !/^[a-z]+(?: [a-z]+)?$/.test(name) || name.length > 80) return;
    const user = c.var.user;
    // Schedule the entire recording operation. Ownership reads must not delay the response either.
    const durationMs = Date.now() - started;
    void bestEffortTelemetry(async () => {
      let outcome: "ok" | "error" | "denied" | "pending-approval" = c.res.status === 403 ? "denied" : c.res.status >= 400 ? "error" : "ok";
      let errorCode = c.res.status === 403 ? "forbidden" : c.res.status >= 400 ? `http_${c.res.status}` : null;
      if (c.res.status === 403) {
        const body: unknown = await c.res.clone().json().catch(() => null);
        if (body && typeof body === "object" && "errorCode" in body && body.errorCode === "policy_denied") errorCode = "policy_denied";
      }
      if (c.req.path.startsWith("/api/actions/") && c.req.path.endsWith("/invoke") && c.res.ok) {
        const response: unknown = await c.res.clone().json();
        if (response && typeof response === "object" && "status" in response) {
          if (response.status === "failed") {
            const denied = "errorCode" in response && response.errorCode === "policy_denied";
            outcome = denied ? "denied" : "error"; errorCode = denied ? "policy_denied" : "action_failed";
          }
          if (response.status === "approval_required") { outcome = "pending-approval"; errorCode = "approval_required"; }
        }
      }
      const parts = c.req.path.split("/");
      let workspace = c.req.query("workspace");
      if (c.res.ok && parts[2] === "actions" && parts[4] === "invoke") {
        const body: unknown = await c.req.json().catch(() => null);
        if (body && typeof body === "object" && "workspace" in body && typeof body.workspace === "string") workspace = body.workspace;
      }
      const owner = c.var.principal.type === "team"
        ? { ownerType: "team" as const, ownerId: c.var.principal.id }
        : await externalWorkflowOwner(c.var.providers.db, user.orgId, c.res.ok ? c.req.path : undefined)
          ?? await externalCallOwner(c.var.providers.db, user.orgId, user.id,
          c.res.ok && parts[2] === "threads" ? parts[3] : undefined, c.res.ok && parts[2] === "sessions" ? parts[3] : undefined, c.res.ok ? workspace : undefined);
      await recordExternalCall(c.var.providers.db, {
        id: `cli:${user.orgId}:${user.id}:${id}`, orgId: user.orgId, userId: user.id, surface: "cli", name,
        clientName: "Valet CLI", clientVersion: version?.slice(0, 100), ...owner,
        outcome, errorCode,
        durationMs, createdAt: started,
      });
    });
  };
}
