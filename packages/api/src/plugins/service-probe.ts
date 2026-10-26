/**
 * The tool listing `/api/plugins` runs for each connected dynamic service,
 * read three ways: as the service's actions (the cached tool schema), for
 * `toolCount`, and for the MCP health probe
 * (docs/specs/2026-07-20-integration-oauth-design.md, "MCP health probe").
 *
 * Dynamic (`resolveActions`) plugins declare zero static actions, so no
 * policy surface can name their tools from the manifest alone: the
 * Policies combobox offered none of them, and the override bounds check
 * refused every one as "not in the plugin catalog". This cache holds the
 * listing the owner's own credential gets, so those surfaces read the same
 * tools a session would call (`DynamicActionSource`, `plugins/action-id.ts`).
 * The same answer says whether the server accepts the connection: a 401, a
 * 403, or tools that need scopes the grant lacks. Those reach the
 * Integrations page as health fields before a run fails on them.
 *
 * Guardrails, since this sits on a page-load path and each probe is a
 * live MCP network call:
 * - per owner+service TTL cache, keyed also by a hash of the access token,
 *   so a reconnect probes again at once;
 * - in-flight dedupe (no stampedes);
 * - a hard timeout that fails soft to `{}`: the row keeps its static label
 *   and its stored health rather than the page blocking on a slow server;
 * - failures and timeouts are never cached, so the next load retries.
 */
import { createHash } from "node:crypto";
import type {
  ActionPlugin,
  Credential,
  CredentialOwner,
  CredentialProvider,
  CredentialStore,
  PluginAction,
  StoredCredential,
} from "@valet/engine";
import { credentialSecret } from "@valet/engine";
import { isMcpActionPlugin, type McpProbeResult } from "@valet/sdk/mcp";
import type { DynamicActionSource } from "./action-id.js";
import type { PluginServiceSummary } from "../wire/types.js";

const TTL_MS = 5 * 60_000;
const DEFAULT_TIMEOUT_MS = 2_500;

/** The health fields only a probe can set. */
export type ProbeHealth = Pick<NonNullable<PluginServiceSummary["health"]>, "rejected" | "missingScopes" | "blockedTools">;

/** What one listing said. Empty when the probe failed or timed out. */
export interface ServiceProbe {
  /** The tools the server listed, as actions. Absent when the server
   * refused the listing, or the probe failed or timed out. */
  actions?: PluginAction[];
  health?: ProbeHealth;
}

interface CacheEntry {
  fingerprint: string;
  probe: ServiceProbe;
  at: number;
}

export class ServiceProbes {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<ServiceProbe>>();

  constructor(
    private readonly deps: {
      credentials: CredentialStore;
      now?: () => number;
      timeoutMs?: number;
    },
  ) {}

  /** The probe for this owner's credential, or `{}` when there is none to
   * probe, or the probe failed or timed out. */
  async get(owner: CredentialOwner, service: string, actionPlugin: ActionPlugin): Promise<ServiceProbe> {
    const resolveActions = actionPlugin.resolveActions;
    if (!resolveActions) return {};
    const stored = await this.deps.credentials.get(owner, service);
    const secret = credentialSecret(stored);
    if (!stored || !secret) return {};

    const key = `${owner.type}:${owner.id}:${service}`;
    const fingerprint = createHash("sha256").update(secret).digest("hex").slice(0, 16);
    const cached = this.cache.get(key);
    if (cached && cached.fingerprint === fingerprint && this.now() - cached.at < TTL_MS) return cached.probe;

    const flightKey = `${key}:${fingerprint}`;
    const running = this.inflight.get(flightKey);
    if (running) return running;

    const credentials = this.credentialProvider(owner, service, stored);
    const listing = isMcpActionPlugin(actionPlugin)
      ? () => actionPlugin.probe({ credentials }).then(fromMcpProbe)
      : () => resolveActions({ credentials }).then((actions): ServiceProbe => ({ actions }));
    const attempt = this.run(key, fingerprint, listing)
      .then((probe) => {
        if (probe.health) console.warn(`integration probe: ${service} for ${owner.type} ${owner.id}: ${probeSummary(probe.health)}`);
        return probe;
      })
      .finally(() => {
        this.inflight.delete(flightKey);
      });
    this.inflight.set(flightKey, attempt);
    return attempt;
  }

  private async run(key: string, fingerprint: string, listing: () => Promise<ServiceProbe>): Promise<ServiceProbe> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const probe = await Promise.race([
        listing(),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        }),
      ]);
      if (probe === undefined) return {}; // timed out — don't cache
      this.cache.set(key, { fingerprint, probe, at: this.now() });
      return probe;
    } catch {
      // A failure that says nothing about the credential (transport, 5xx).
      // Sessions surface the real error through list_tools.
      return {};
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * The tools each dynamic service lists for `owner`, for a policy surface
   * (`DynamicActionSource`). Cached by `get`, or listed live under the same
   * limits. An empty answer means the listing is unknown: no credential, a
   * refusal, a failure, or a timeout.
   */
  listedActionsFor(owner: CredentialOwner): DynamicActionSource {
    return async (service, actionPlugin) => (await this.get(owner, service, actionPlugin)).actions ?? [];
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Same StoredCredential→Credential mapping as `action-invoker.ts`'s
   * provider. The row already read answers for `service`; any other key
   * (an app-identity fallback) is read from the store. */
  private credentialProvider(owner: CredentialOwner, service: string, stored: StoredCredential): CredentialProvider {
    const store = this.deps.credentials;
    return {
      async get(requested?: string): Promise<Credential | null> {
        const row = requested === undefined || requested === service ? stored : await store.get(owner, requested);
        if (!row) return null;
        const accessToken = credentialSecret(row) ?? "";
        if (accessToken === "") return null;
        return {
          accessToken,
          refreshToken: row.refreshToken,
          expiresAt: row.expiresAt,
          scopes: row.scopes,
          metadata: row.metadata,
        };
      },
      request(): Promise<Credential> {
        return Promise.reject(new Error("credential requests are not supported in the plugins listing"));
      },
    };
  }
}

function fromMcpProbe(result: McpProbeResult): ServiceProbe {
  switch (result.kind) {
    case "listed":
      if (result.missingScopes.length === 0) return { actions: result.actions };
      return {
        actions: result.actions,
        health: { missingScopes: result.missingScopes, blockedTools: result.blockedTools },
      };
    case "insufficient_scope":
      return { health: { missingScopes: result.missingScopes } };
    case "rejected":
      return { health: { rejected: true } };
  }
}

function probeSummary(health: ProbeHealth): string {
  if (health.rejected) return "the server rejected the credential";
  const tools = health.blockedTools === undefined ? "the tool list" : `${health.blockedTools} tools`;
  return `the grant lacks ${health.missingScopes?.join(", ")} for ${tools}`;
}
