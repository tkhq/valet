/**
 * The ValetPlugin manifest — the single seam between plugin packages and
 * hosts (spec: docs/specs/2026-07-13-plugin-system-v2-design.md). Composes
 * only engine-owned types; the engine gains no dependencies.
 *
 * Entry-point convention: a plugin package declares
 * `"valet": { "plugin": "./dist/plugin.js" }` in package.json; that
 * module's default export is a ValetPlugin, or a
 * `() => ValetPlugin | Promise<ValetPlugin>` factory. The marker's presence
 * is the whole contract — a package without it is not a plugin.
 *
 * See the "Channel transports" section below for the v2 ChannelTransport
 * contract (Telegram, Phase 7).
 */
import type { ActionPlugin } from "./plugin-catalog.js";
import type { RiskLevel, SkillSource, RoleSpec, StoredCredential } from "./types.js";
import { BUILTIN_COMMAND_NAMES, type CommandDef } from "./commands/types.js";

/** How the connect UI obtains an oauth2 credential (integration-OAuth design). */
export type OAuthDeclaration =
  | {
      /** MCP OAuth: RFC 8414 discovery + RFC 7591 dynamic registration, PKCE public client. */
      mode: "mcp";
      /** The MCP server URL discovery runs against (same URL the plugin's mcpActionPlugin uses). */
      serverUrl: string;
    }
  | {
      /** Pre-registered confidential client; id/secret come from the host's env. */
      mode: "authorization_code";
      authorizationUrl: string;
      tokenUrl: string;
      clientIdEnv: string;
      clientSecretEnv: string;
      /** Extra authorize-URL params, e.g. Google's access_type=offline&prompt=consent. */
      extraAuthParams?: Record<string, string>;
    };

export interface CredentialDeclaration {
  /** Service the credential is stored under. Defaults to the plugin name. */
  service?: string;
  type: "oauth2" | "api_key" | "bot_token" | "service_account";
  /** OAuth scopes, for oauth2 declarations. */
  scopes?: string[];
  /** Keys the plugin's actions read off the resolved Credential (e.g. ["accessToken"]). */
  configKeys: string[];
  /** Human copy for connect UI. */
  connectLabel?: string;
  /** How the connect UI obtains this credential via OAuth. Absent = manual token entry only. Only valid on `type: "oauth2"`. */
  oauth?: OAuthDeclaration;
}

/** A webhook event that passed signature verification. */
export interface VerifiedEvent {
  eventType: string;
  deliveryId: string;
  payload: unknown;
}

/** A provider webhook normalized into the generic event pipeline. */
export interface NormalizedEvent {
  /** Namespaced key, e.g. "github.pull_request.opened", "linear.issue.create". */
  key: string;
  /** Provider delivery id — unique per service; makes redelivery idempotent. */
  dedupeKey: string;
  /** ISO timestamp of when the event happened at the provider. */
  occurredAt: string;
  /** External actor, when the payload carries one (enables identity-link attribution). */
  actor?: { externalId: string; login?: string };
  /** Flat scope refs for filtering/display: repo, installation_id, team_id, … */
  refs: Record<string, string>;
  /** One-line human summary (used as the SignalContent body for orchestrator delivery). */
  summary: string;
  /** Raw provider payload. */
  payload: unknown;
}

export interface EventCatalogEntry {
  key: string;
  description: string;
  /** Filterable fields: `field` is the user-facing name, `path` a dot-path into the raw payload. */
  filters: { field: string; path: string; description: string }[];
}

export interface TriggerDef {
  /** e.g. "github.pull_request" */
  id: string;
  service: string;
  description: string;
  /**
   * Signature verification over the exact raw request bytes, BEFORE any
   * parsing. Return null to reject. May be async (HMAC via node/web crypto).
   */
  verify(
    req: { headers: Record<string, string>; rawBody: Uint8Array },
    secrets: Record<string, string>,
  ): VerifiedEvent | null | Promise<VerifiedEvent | null>;
  /** Normalize a verified event for the generic event pipeline. */
  toEvent(event: VerifiedEvent): NormalizedEvent;
  /** Subscribable event keys this trigger can emit, with their filterable fields. */
  catalog: EventCatalogEntry[];
}

// ─── Channel transports (v2 contract, Phase 7) ─────────────────────────────
//
// Verify-before-parse, same philosophy as TriggerDef: the host hands raw
// bytes to `verifyWebhook` (or consumes `poll()`), then feeds each
// RawChannelUpdate through `parseUpdate`. Conversation keys are a
// transport-owned codec (e.g. "telegram:dm:{chatId}") — the host treats
// them as opaque and passes them back verbatim for outbound sends.

/** One raw provider update (e.g. a Telegram Update object). Opaque to the host. */
export type RawChannelUpdate = unknown;

export interface TransportContext {
  /** Resolved org credential for the transport's service (e.g. the bot token). */
  credential: StoredCredential;
  /** Transport-specific config. Factories never read env vars. */
  config: Record<string, string>;
}

export interface ChannelSender {
  externalId: string;
  displayName?: string;
}

export interface InboundChannelMedia {
  kind: "photo" | "document" | "voice" | "audio";
  fileId: string;
  mimeType?: string;
  fileName?: string;
  fileSize?: number;
}

/** Where a sent message landed; also the correlation handle for gate edits. */
export interface SendRef {
  conversationKey: string;
  messageId: string;
}
export type GatePromptRef = SendRef;

export interface InboundChannelEvent {
  /** Dedup key, e.g. "telegram:{update_id}". */
  dispatchId: string;
  conversationKey: string;
  sender: ChannelSender;
  kind: "message" | "command" | "gate_callback";
  text?: string;
  /** Set when kind === "command" (e.g. /start <code>). */
  command?: { name: string; args?: string };
  media?: InboundChannelMedia[];
  /** Set when kind === "gate_callback". `ref` identifies the gate-prompt message. */
  gateCallback?: { actionId: string; callbackId: string; ref: GatePromptRef };
  raw: RawChannelUpdate;
}

export interface OutboundChannelMessage {
  markdown: string;
}

export type OutboundChannelAttachment =
  | { type: "image"; data: Uint8Array; mimeType: string; name?: string; caption?: string }
  | { type: "file"; data: Uint8Array; mimeType: string; name: string; caption?: string };

export interface ChannelGatePrompt {
  gateId: string;
  title: string;
  body?: string;
  actions: Array<{ id: string; label: string; style?: "primary" | "danger" }>;
}

export interface ChannelGateResolution {
  actionId?: string;
  /** Human-readable outcome line, e.g. "✅ Approved by conner". */
  label: string;
}

export interface FetchedChannelMedia {
  data: Uint8Array;
  mimeType: string;
  name?: string;
}

export interface ChannelTransport {
  readonly channelType: string;
  /**
   * Verify an incoming webhook and extract its raw updates. `null` = reject.
   * secrets carries host-held values (for Telegram: { webhookSecret }).
   */
  verifyWebhook(
    req: { headers: Record<string, string>; rawBody: Uint8Array },
    secrets: Record<string, string>,
  ): RawChannelUpdate[] | null;
  /** Long-poll ingress; yields until `signal` aborts. Optional per transport. */
  poll?(signal: AbortSignal): AsyncIterable<RawChannelUpdate>;
  /** Normalize one raw update. `null` = not something we handle. */
  parseUpdate(update: RawChannelUpdate): InboundChannelEvent | null;
  send(conversationKey: string, message: OutboundChannelMessage): Promise<SendRef>;
  sendMedia(conversationKey: string, attachment: OutboundChannelAttachment): Promise<SendRef>;
  sendGatePrompt(conversationKey: string, gate: ChannelGatePrompt): Promise<GatePromptRef>;
  updateGatePrompt(ref: GatePromptRef, resolution: ChannelGateResolution): Promise<void>;
  /** Download inbound media. `null` = unavailable (oversize, expired, …). */
  fetchMedia?(media: InboundChannelMedia): Promise<FetchedChannelMedia | null>;
  sendTyping?(conversationKey: string): Promise<void>;
  /** Ack an interactive callback (Telegram answerCallbackQuery). */
  answerCallback?(callbackId: string, text?: string): Promise<void>;
  /** Register the webhook endpoint with the provider (webhook mode only). */
  registerWebhook?(url: string, secretToken: string): Promise<void>;
}

export interface ChannelTransportFactory {
  channelType: string;
  create(ctx: TransportContext): ChannelTransport;
}

export interface ValetPlugin {
  /** Plugin id, e.g. "github". Unique across loaded plugins. */
  name: string;
  version: string;
  description?: string;
  actions?: ActionPlugin[];
  triggers?: TriggerDef[];
  skills?: SkillSource[];
  roles?: RoleSpec[];
  credentials?: CredentialDeclaration[];
  transports?: ChannelTransportFactory[];
  /** Action-backed slash commands this plugin exposes. */
  commands?: CommandDef[];
}

export interface PluginValidationIssue {
  path: string;
  message: string;
}

const NAME_RE = /^[a-z][a-z0-9-]*$/;
const RISK_LEVELS: readonly RiskLevel[] = ["low", "medium", "high", "critical"];
const CREDENTIAL_TYPES = ["oauth2", "api_key", "bot_token", "service_account"] as const;

/**
 * Structural validation of an unknown value as a ValetPlugin. Hand-rolled
 * rather than a TypeBox schema because manifests carry functions (execute,
 * verify, toEvent, resolveActions), which JSON Schema cannot express.
 * Collects every issue instead of failing fast so quarantine logs are
 * actionable in one pass.
 */
export function validateValetPlugin(
  value: unknown,
): { ok: true; plugin: ValetPlugin } | { ok: false; issues: PluginValidationIssue[] } {
  const issues: PluginValidationIssue[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, issues: [{ path: "", message: "manifest must be an object" }] };
  }
  const v = value as Record<string, unknown>;

  if (typeof v.name !== "string" || !NAME_RE.test(v.name)) {
    issues.push({ path: "name", message: "required string matching /^[a-z][a-z0-9-]*$/" });
  }
  if (typeof v.version !== "string" || v.version.length === 0) {
    issues.push({ path: "version", message: "required non-empty string" });
  }
  if (v.description !== undefined && typeof v.description !== "string") {
    issues.push({ path: "description", message: "must be a string when present" });
  }

  checkArray(v.actions, "actions", issues, (p, path) => {
    const plugin = asRecord(p, path, issues);
    if (!plugin) return;
    if (typeof plugin.service !== "string" || plugin.service.length === 0) {
      issues.push({ path: `${path}.service`, message: "required non-empty string" });
    }
    if (plugin.resolveActions !== undefined && typeof plugin.resolveActions !== "function") {
      issues.push({ path: `${path}.resolveActions`, message: "must be a function when present" });
    }
    if (!Array.isArray(plugin.actions)) {
      issues.push({ path: `${path}.actions`, message: "required array" });
      return;
    }
    plugin.actions.forEach((a, i) => {
      const action = asRecord(a, `${path}.actions[${i}]`, issues);
      if (!action) return;
      for (const key of ["id", "name", "description"] as const) {
        if (typeof action[key] !== "string" || action[key].length === 0) {
          issues.push({ path: `${path}.actions[${i}].${key}`, message: "required non-empty string" });
        }
      }
      if (!RISK_LEVELS.includes(action.riskLevel as RiskLevel)) {
        issues.push({ path: `${path}.actions[${i}].riskLevel`, message: `must be one of ${RISK_LEVELS.join("|")}` });
      }
      if (typeof action.parameters !== "object" || action.parameters === null) {
        issues.push({ path: `${path}.actions[${i}].parameters`, message: "required schema object" });
      }
      if (typeof action.execute !== "function") {
        issues.push({ path: `${path}.actions[${i}].execute`, message: "required function" });
      }
    });
  });

  checkArray(v.triggers, "triggers", issues, (t, path) => {
    const trigger = asRecord(t, path, issues);
    if (!trigger) return;
    for (const key of ["id", "service", "description"] as const) {
      if (typeof trigger[key] !== "string" || trigger[key].length === 0) {
        issues.push({ path: `${path}.${key}`, message: "required non-empty string" });
      }
    }
    for (const key of ["verify", "toEvent"] as const) {
      if (typeof trigger[key] !== "function") {
        issues.push({ path: `${path}.${key}`, message: "required function" });
      }
    }
    if (trigger.catalog === undefined) {
      issues.push({ path: `${path}.catalog`, message: "required array" });
    } else {
      checkArray(trigger.catalog, `${path}.catalog`, issues, (entry, entryPath) => {
        const e = asRecord(entry, entryPath, issues);
        if (!e) return;
        if (typeof e.key !== "string" || e.key.length === 0) {
          issues.push({ path: `${entryPath}.key`, message: "required non-empty string" });
        }
        if (typeof e.description !== "string") {
          issues.push({ path: `${entryPath}.description`, message: "required string" });
        }
        if (!Array.isArray(e.filters)) {
          issues.push({ path: `${entryPath}.filters`, message: "required array" });
        }
      });
    }
  });

  checkArray(v.skills, "skills", issues, (s, path) => {
    const skill = asRecord(s, path, issues);
    if (!skill) return;
    if (typeof skill.name !== "string" || skill.name.length === 0) {
      issues.push({ path: `${path}.name`, message: "required non-empty string" });
    }
    if (typeof skill.content !== "string") {
      issues.push({ path: `${path}.content`, message: "required string" });
    }
  });

  checkArray(v.roles, "roles", issues, (r, path) => {
    const role = asRecord(r, path, issues);
    if (!role) return;
    if (typeof role.name !== "string" || role.name.length === 0) {
      issues.push({ path: `${path}.name`, message: "required non-empty string" });
    }
    if (typeof role.content !== "string") {
      issues.push({ path: `${path}.content`, message: "required string" });
    }
  });

  checkArray(v.credentials, "credentials", issues, (c, path) => {
    const cred = asRecord(c, path, issues);
    if (!cred) return;
    if (!CREDENTIAL_TYPES.includes(cred.type as (typeof CREDENTIAL_TYPES)[number])) {
      issues.push({ path: `${path}.type`, message: `must be one of ${CREDENTIAL_TYPES.join("|")}` });
    }
    if (!Array.isArray(cred.configKeys) || cred.configKeys.some((k) => typeof k !== "string")) {
      issues.push({ path: `${path}.configKeys`, message: "required string array" });
    }
    if (cred.service !== undefined && typeof cred.service !== "string") {
      issues.push({ path: `${path}.service`, message: "must be a string when present" });
    }
    if (cred.oauth !== undefined) {
      const oauth = asRecord(cred.oauth, `${path}.oauth`, issues);
      if (!oauth) return;
      if (cred.type !== "oauth2") {
        issues.push({ path: `${path}.oauth`, message: "only valid on type=\"oauth2\" declarations" });
        return;
      }
      if (oauth.mode === "mcp") {
        if (typeof oauth.serverUrl !== "string" || oauth.serverUrl.length === 0) {
          issues.push({ path: `${path}.oauth.serverUrl`, message: "required non-empty string" });
        }
      } else if (oauth.mode === "authorization_code") {
        for (const key of ["authorizationUrl", "tokenUrl", "clientIdEnv", "clientSecretEnv"] as const) {
          if (typeof oauth[key] !== "string" || oauth[key].length === 0) {
            issues.push({ path: `${path}.oauth.${key}`, message: "required non-empty string" });
          }
        }
        if (oauth.extraAuthParams !== undefined) {
          const params = asRecord(oauth.extraAuthParams, `${path}.oauth.extraAuthParams`, issues);
          if (params && Object.values(params).some((v) => typeof v !== "string")) {
            issues.push({ path: `${path}.oauth.extraAuthParams`, message: "values must be strings" });
          }
        }
      } else {
        issues.push({ path: `${path}.oauth.mode`, message: "must be \"mcp\" or \"authorization_code\"" });
      }
    }
  });

  checkArray(v.transports, "transports", issues, (item, path) => {
    const t = item as Partial<ChannelTransportFactory>;
    if (typeof t.channelType !== "string" || t.channelType === "") {
      issues.push({ path: `${path}.channelType`, message: "must be a non-empty string" });
    }
    if (typeof t.create !== "function") {
      issues.push({ path: `${path}.create`, message: "must be a function" });
    }
  });

  checkArray(v.commands, "commands", issues, (cmd, path) => {
    const c = asRecord(cmd, path, issues);
    if (!c) return;
    if (typeof c.name !== "string" || !NAME_RE.test(c.name)) {
      issues.push({ path: `${path}.name`, message: `must match ${NAME_RE.source}` });
    } else if ((BUILTIN_COMMAND_NAMES as readonly string[]).includes(c.name)) {
      issues.push({ path: `${path}.name`, message: `"${c.name}" is a reserved built-in command name` });
    }
    if (typeof c.description !== "string" || c.description.length === 0) {
      issues.push({ path: `${path}.description`, message: "must be a non-empty string" });
    }
    if (typeof c.mapArgs !== "function") {
      issues.push({ path: `${path}.mapArgs`, message: "must be a function" });
    }
    // Collect all action ids declared in this plugin's actions array.
    const actionIds = new Set<string>(
      (Array.isArray(v.actions) ? v.actions : []).flatMap((ap) => {
        const apRecord = asRecord(ap, "", []);
        if (!apRecord || !Array.isArray(apRecord.actions)) return [];
        return apRecord.actions.map((a) => {
          const aRecord = asRecord(a, "", []);
          return typeof aRecord?.id === "string" ? aRecord.id : undefined;
        }).filter((id): id is string => id !== undefined);
      }),
    );
    if (typeof c.action !== "string" || !actionIds.has(c.action)) {
      issues.push({ path: `${path}.action`, message: "must name an action declared by this plugin" });
    }
  });

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, plugin: value as ValetPlugin };
}

function checkArray(
  value: unknown,
  field: string,
  issues: PluginValidationIssue[],
  each: (item: unknown, path: string) => void,
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    issues.push({ path: field, message: "must be an array when present" });
    return;
  }
  value.forEach((item, i) => each(item, `${field}[${i}]`));
}

function asRecord(
  value: unknown,
  path: string,
  issues: PluginValidationIssue[],
): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) {
    issues.push({ path, message: "must be an object" });
    return null;
  }
  return value as Record<string, unknown>;
}
