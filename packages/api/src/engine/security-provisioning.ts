/**
 * Declared-tool provisioning for a security persona child (Valet Security
 * M-P4a + M-P4b, spec §Declared tools + provisioning, §Live personas +
 * authorized scope + scoped egress).
 *
 * The mechanism: a repo's `.valet/security.yml` declares the tools a step needs
 * (`tools`) and the authorized live-testing scope (`scope`). The create route
 * stores them on the engagement (`config_tools`, `authorized_scope`). At
 * persona-child build the host calls the functions here to:
 *
 *   1. Wire each declared MCP server into the child's tool set (a `ValetPlugin`
 *      per decl, added to the child's extra plugins). This reuses the same
 *      `mcpActionPlugin` seam config-declared MCP connectors use.
 *   2. Build the authorized-scope egress allowlist env the child sandbox
 *      carries. The live tools read `VALET_SECURITY_AUTHORIZED_SCOPE` to bound
 *      their egress to the human-declared scope.
 *
 * Deferred DATA (not mechanism): a decl's `install`/`image` names a scanner the
 * sandbox prep or a container runs. Baking a specific scanner (nuclei, ZAP) is
 * provisioning data the mechanism accepts, wired per repo — see the spec's
 * deferred-data note. The install-at-prep path is a documented follow-up
 * anchored on `ToolDecl.install`.
 *
 * Egress enforcement seam: `SandboxCreateOpts` carries no network-policy field
 * today, so the honest enforcement point is the env allowlist the live tools
 * read PLUS a network-policy TODO anchored where the sandbox is created. See
 * `authorizedScopeEnv` and the spec's egress section.
 */
import { mcpActionPlugin } from "@valet/sdk";
import type { ValetPlugin } from "@valet/engine";
import { egressHostInScope, type ToolDecl } from "@valet/plugin-security";

/** The env var the child sandbox carries the authorized scope in (M-P4b). A
 * live tool reads it to bound its egress to the human-declared hosts. Comma-
 * separated host list; absent/empty means no live testing is authorized. */
export const AUTHORIZED_SCOPE_ENV = "VALET_SECURITY_AUTHORIZED_SCOPE";

/** Parse the engagement's `config_tools` JSON into `ToolDecl[]`. A
 * null/absent/malformed value yields []. A legacy bare-string item normalizes
 * to `{ id }`. */
export function parseConfigToolDecls(raw: string | null): ToolDecl[] {
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const decls: ToolDecl[] = [];
  for (const item of parsed) {
    if (typeof item === "string" && item.trim() !== "") {
      decls.push({ id: item.trim() });
      continue;
    }
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const map = item as Record<string, unknown>;
    if (typeof map.id !== "string" || map.id.trim() === "") continue;
    const decl: ToolDecl = { id: map.id.trim() };
    if (typeof map.install === "string") decl.install = map.install;
    if (typeof map.image === "string") decl.image = map.image;
    if (typeof map.mcp === "object" && map.mcp !== null && !Array.isArray(map.mcp)) {
      const mcp = map.mcp as Record<string, unknown>;
      if (typeof mcp.url === "string") {
        decl.mcp = { url: mcp.url, ...(typeof mcp.prefix === "string" ? { prefix: mcp.prefix } : {}) };
      }
    }
    if (Array.isArray(map.egress)) {
      const egress = map.egress.filter((h): h is string => typeof h === "string");
      if (egress.length > 0) decl.egress = egress;
    }
    decls.push(decl);
  }
  return decls;
}

/** Parse the engagement's `authorized_scope` JSON into the host list (M-P4b). A
 * null/absent/malformed value yields []. */
export function parseAuthorizedScopeHosts(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const hosts = (parsed as Record<string, unknown>).hosts;
      if (Array.isArray(hosts)) return hosts.filter((h): h is string => typeof h === "string");
    }
  } catch {
    // A malformed value is treated as no scope.
  }
  return [];
}

/**
 * The declared MCP servers to wire into a persona child, as `ValetPlugin`s
 * (M-P4a). One plugin per declared tool that carries an `mcp` block. The
 * service name is the tool id (or the mcp prefix, stripped of `mcp__`
 * decoration), so the child's tool list carries the server's tools under a
 * stable prefix. `noAuth` is set — a self-hosted scanner MCP server on the
 * sandbox network needs no per-user credential; the egress allowlist bounds it.
 *
 * A decl with no `mcp` block contributes nothing (its install/image is a
 * separate prep concern). An empty decl list yields no plugins.
 */
export function securityDeclaredMcpPlugins(decls: readonly ToolDecl[]): ValetPlugin[] {
  const plugins: ValetPlugin[] = [];
  for (const decl of decls) {
    if (!decl.mcp) continue;
    const service = mcpServiceName(decl);
    plugins.push({
      name: `security-tool-${service}`,
      version: "0.0.0",
      description: `Declared security tool "${decl.id}" (MCP): ${decl.mcp.url}`,
      actions: [
        mcpActionPlugin({
          mcpUrl: decl.mcp.url,
          serviceName: service,
          defaultRiskLevel: "high",
          // A self-hosted scanner MCP server on the sandbox network is not a
          // per-user credentialed connector; the egress allowlist is the guard.
          noAuth: true,
        }),
      ],
    });
  }
  return plugins;
}

/** The MCP service name for a declared tool (M-P4a): the mcp prefix without its
 * `mcp__…__` decoration, else the tool id. So `prefix: mcp__zap__` → `zap`. */
function mcpServiceName(decl: ToolDecl): string {
  const prefix = decl.mcp?.prefix;
  if (prefix && prefix.trim() !== "") {
    return prefix.replace(/^mcp__/, "").replace(/__$/, "").trim() || decl.id;
  }
  return decl.id;
}

/**
 * The authorized-scope egress allowlist env for a persona child sandbox
 * (M-P4b). Returns `{ [AUTHORIZED_SCOPE_ENV]: "host1,host2" }` when the scope
 * names hosts, else `{}` (an empty scope authorizes nothing — the live persona
 * is told to stop). The live tools read this env to bound their egress.
 *
 * This is the egress ENFORCEMENT SEAM on providers without a network policy: the
 * allowlist rides in the sandbox env, and the live tooling honors it. Full
 * network-level enforcement (a k8s NetworkPolicy / egress firewall keyed on this
 * list) is a sandbox-infra follow-up — see the spec's egress section and the
 * TODO on the host's persona-child sandbox build.
 */
export function authorizedScopeEnv(scopeHosts: readonly string[]): Record<string, string> {
  const clean = scopeHosts.map((h) => h.trim()).filter((h) => h !== "");
  if (clean.length === 0) return {};
  return { [AUTHORIZED_SCOPE_ENV]: clean.join(",") };
}

/**
 * Validate that every declared tool's egress is within the authorized scope
 * (M-P4b). The config parser already refuses an out-of-scope egress at create,
 * but a stored engagement (or a hand-edited row) is re-checked here before the
 * host provisions the tools, so a live tool is never provisioned with egress
 * outside the human-declared scope. Returns the offending `host`/`toolId` pairs;
 * an empty array means every egress is in scope.
 */
export function egressViolations(
  decls: readonly ToolDecl[],
  scopeHosts: readonly string[],
): { toolId: string; host: string }[] {
  const violations: { toolId: string; host: string }[] = [];
  for (const decl of decls) {
    for (const host of decl.egress ?? []) {
      if (!egressHostInScope(host, scopeHosts)) {
        violations.push({ toolId: decl.id, host });
      }
    }
  }
  return violations;
}
