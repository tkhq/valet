/**
 * Admin configuration audit log and security alerts
 * (docs/specs/2026-11-03-admin-audit-log-design.md).
 *
 * Each admin mutation calls `recordAdminAudit` once, after the change
 * succeeds. The call writes one `admin_audit_events` row. When the action is
 * high risk, it also emits the `security.admin_change` alert: a warn log
 * line, the `valet.security.admin_changes` counter, and a POST to
 * `VALET_SECURITY_ALERT_WEBHOOK_URL` when the operator set one.
 *
 * Failure policy. The caller's change is already committed when this runs,
 * so a failed audit write does not fail the request: a 500 for a change
 * that took effect invites a retry that applies it twice. The failure is
 * loud instead. It logs at error level and counts in
 * `valet.errors{area="api",reason="admin_audit_write"}`. The alert still
 * fires, because it does not depend on the row.
 *
 * Secrets. Callers pass field names and safe values only: never an API
 * key, token, or password. `sanitizeChanges` is the backstop. It drops any
 * key whose name looks like a secret, removes URL userinfo and query
 * strings, masks `NAME=value` assignments for secret-like names in strings,
 * and caps sizes.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, lt, or, type SQL } from "drizzle-orm";
import { metrics } from "@opentelemetry/api";
import { log, reportError } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { adminAuditEvents, type AdminAuditEventRow } from "../schema/index.js";

/** The kinds of thing an audit row can name. A metric label and a filter. */
export const ADMIN_AUDIT_TARGET_TYPES = [
  "org",
  "org_member",
  "user",
  "invite",
  "auth_policy",
  "org_settings",
  "llm_provider",
  "image_source",
  "bake",
  "credential",
  "credential_share",
  "plugin",
  "org_policy",
  "team_policy",
  "model_policy",
] as const;
export type AdminAuditTargetType = (typeof ADMIN_AUDIT_TARGET_TYPES)[number];

export function isAdminAuditTargetType(value: unknown): value is AdminAuditTargetType {
  return typeof value === "string" && (ADMIN_AUDIT_TARGET_TYPES as readonly string[]).includes(value);
}

/** The high-risk change kinds that raise `security.admin_change`. */
export type SecurityAlertKind =
  | "new_admin"
  | "new_user"
  | "llm_provider_created"
  | "llm_provider_base_url_changed"
  | "image_source_created"
  | "image_source_changed"
  | "builtin_image_changed"
  | "sign_in_policy_changed";

/** Who made the change. Null `userId` means the system (a boot step). */
export interface AdminAuditActor {
  userId: string | null;
  email: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export interface AdminAuditEntry {
  orgId: string;
  actor: AdminAuditActor;
  /** `<target_type>.<verb>`, such as `llm_provider.create`. Stable: alerts and filters key on it. */
  action: string;
  targetType: AdminAuditTargetType;
  targetId?: string | null;
  targetName?: string | null;
  /** Field-level summary. Values pass through `sanitizeChanges`. */
  changes?: Record<string, unknown> | null;
  /** Set by the caller when the change is high risk. */
  alert?: SecurityAlertKind | null;
}

/** The stable event name on the alert log line and the webhook body. */
export const SECURITY_ALERT_EVENT = "security.admin_change";
/** The env var that names the alert webhook. Fixed at deploy time by the operator. */
export const SECURITY_ALERT_WEBHOOK_ENV = "VALET_SECURITY_ALERT_WEBHOOK_URL";
const WEBHOOK_TIMEOUT_MS = 5_000;

// ── Redaction ───────────────────────────────────────────────────────────────

const SECRET_KEY = /(api[_-]?key|apikey|token|secret|password|passwd|private[_-]?key|authorization|cookie|credential_value)/i;
const SECRET_ASSIGNMENT = /\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Za-z0-9_]*|[A-Za-z0-9_]*_PAT)=("[^"]*"|'[^']*'|\S+)/gi;
const BEARER = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
// Credentials passed as command-line options or headers in setup commands.
// The patterns cover common forms; the alert carries no values at all.
const USER_PASS_OPTION = /(\s(?:-u|-U|--user|--proxy-user|--basic-auth))(\s+|=)(["']?)([^\s:"']*):([^\s"']+)\3/g;
const SECRET_OPTION = /(\s--?(?:password|passwd|pass|token|api-key|apikey|secret|auth-token|access-key|secret-key|private-key|client-secret|registry-password)[A-Za-z0-9-]*)(\s+|=)("[^"]*"|'[^']*'|[^\s"']+)/gi;
const SECRET_HEADER = /((?:authorization|proxy-authorization|x-api-key|api-key|private-token|x-auth-token|cookie)\s*:\s*)[^"'\n]+/gi;
const SHORT_PASSWORD = /(\b(?:sshpass|mysql|mysqldump|mariadb)\b[^|;&\n]*?\s-p)(\s*)(?=[^\s-])([^\s"']+)/g;
const URL_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
const MAX_STRING = 500;
const MAX_ARRAY = 50;
const MAX_DEPTH = 4;

/** A URL as scheme, host, and path: userinfo and query can carry a token. */
export function displayUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return `${url.protocol}//${url.host}${url.pathname === "/" ? "" : url.pathname}`;
    }
  } catch {
    // Not an absolute URL: handled below.
  }
  // Another scheme (ssh://user:pass@host), or a schemeless reference such as
  // the image ref user:pass@registry/repo:tag, which parses as a URL with
  // `user:` as its scheme. Drop the user info and query.
  return (raw.split(/[?#]/)[0] ?? "").replace(/^([a-z][a-z0-9+.-]*:\/\/)?[^/@]*@/i, "$1");
}

function sanitizeString(value: string): string {
  const masked = value
    .replace(URL_TEXT, (match) => displayUrl(match))
    .replace(SECRET_ASSIGNMENT, (_m, name: string) => `${name}=[redacted]`)
    .replace(BEARER, (_m, scheme: string) => `${scheme} [redacted]`)
    .replace(USER_PASS_OPTION, (_m, flag: string, sep: string, quote: string, user: string) => `${flag}${sep}${quote}${user}:[redacted]${quote}`)
    // `--password-stdin` and `--password-file` take no secret value.
    .replace(SECRET_OPTION, (m, flag: string, sep: string) => (/-(stdin|file)$/i.test(flag) ? m : `${flag}${sep}[redacted]`))
    .replace(SECRET_HEADER, (_m, name: string) => `${name}[redacted]`)
    .replace(SHORT_PASSWORD, (_m, prefix: string, gap: string) => `${prefix}${gap}[redacted]`);
  return masked.length > MAX_STRING ? `${masked.slice(0, MAX_STRING)}…` : masked;
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return sanitizeString(value);
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY).map((item) => sanitizeValue(item, depth + 1));
    if (value.length > MAX_ARRAY) items.push(`… ${value.length - MAX_ARRAY} more`);
    return items;
  }
  if (typeof value === "object") return sanitizeObject(value, depth + 1);
  return undefined;
}

function sanitizeObject(value: object, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY.test(key) || item === undefined) continue;
    out[key] = sanitizeValue(item, depth);
  }
  return out;
}

/** The backstop redaction for `changes`. Exported for tests. */
export function sanitizeChanges(changes: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!changes) return null;
  const out = sanitizeObject(changes, 0);
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Setup commands as audit data: their count and a SHA-256 digest, never the
 * text. A command can carry a credential in any option or header, so no
 * mask list covers them all. Admins read the commands on the source itself.
 */
export function commandDigest(commands: unknown): { count: number; sha256: string } | null {
  if (!Array.isArray(commands)) return null;
  return { count: commands.length, sha256: createHash("sha256").update(JSON.stringify(commands)).digest("hex") };
}

/** `{ field: { from, to } }` for each listed field whose value changed. */
export function diffFields<T extends object>(
  before: T,
  after: Partial<T>,
  fields: readonly (keyof T & string)[],
): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const field of fields) {
    if (!(field in after)) continue;
    const from = before[field] ?? null;
    const to = after[field] ?? null;
    if (JSON.stringify(from) !== JSON.stringify(to)) out[field] = { from, to };
  }
  return out;
}

// ── Metrics ─────────────────────────────────────────────────────────────────

type Counter = ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]>;
let alertCounter: Counter | undefined;

function countAlert(kind: SecurityAlertKind): void {
  alertCounter ??= metrics.getMeter("@valet/api").createCounter("valet.security.admin_changes", {
    description: "High-risk admin configuration changes, by kind",
  });
  alertCounter.add(1, { kind });
}

// ── Alert delivery ──────────────────────────────────────────────────────────

const pendingWebhooks = new Set<Promise<void>>();

/** Waits for in-flight webhook posts. Tests and graceful shutdown only. */
export async function flushSecurityAlerts(): Promise<void> {
  while (pendingWebhooks.size > 0) await Promise.allSettled([...pendingWebhooks]);
}

function webhookUrl(): string | undefined {
  const raw = process.env[SECURITY_ALERT_WEBHOOK_ENV]?.trim();
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol === "https:" || url.protocol === "http:") return url.toString();
  } catch {
    // Reported below with the corrective action.
  }
  reportError(
    { area: "api", reason: "security_alert_webhook_config", level: "warn" },
    `${SECURITY_ALERT_WEBHOOK_ENV} is not an http or https URL. Set it to the alert receiver URL and restart the api.`,
  );
  return undefined;
}

async function postWebhook(url: string, body: Record<string, unknown>): Promise<void> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    if (!res.ok) {
      reportError(
        { area: "api", reason: "security_alert_webhook", level: "warn", fields: { status: res.status } },
        `The security alert webhook answered ${res.status}. Check the receiver at ${SECURITY_ALERT_WEBHOOK_ENV}.`,
      );
    }
  } catch (err) {
    reportError(
      { area: "api", reason: "security_alert_webhook", level: "warn" },
      `The security alert webhook did not answer. Check the receiver at ${SECURITY_ALERT_WEBHOOK_ENV}.`,
      err,
    );
  }
}

function emitSecurityAlert(entry: AdminAuditEntry, kind: SecurityAlertKind, changes: Record<string, unknown> | null, at: number): void {
  const body = {
    event: SECURITY_ALERT_EVENT,
    kind,
    orgId: entry.orgId,
    action: entry.action,
    targetType: entry.targetType,
    // No target name: it is admin-chosen text. Read it in the audit row.
    targetId: entry.targetId ?? null,
    actorUserId: entry.actor.userId,
    actorEmail: entry.actor.email,
    ip: entry.actor.ip ?? null,
    // Field names only. Values stay in the audit row, so no admin-entered
    // text or credential leaves the instance in an alert.
    changedFields: changes ? Object.keys(changes) : [],
    at: new Date(at).toISOString(),
  };
  countAlert(kind);
  log.warn(`${SECURITY_ALERT_EVENT}: ${entry.action} on ${entry.targetType} ${entry.targetId ?? ""}`.trim(), body);
  const url = webhookUrl();
  if (!url) return;
  const pending = postWebhook(url, body).finally(() => pendingWebhooks.delete(pending));
  pendingWebhooks.add(pending);
}

// ── Write ───────────────────────────────────────────────────────────────────

/**
 * Writes one audit row and raises the alert when `entry.alert` is set.
 * Never throws: see the failure policy at the top of this file.
 */
export async function recordAdminAudit(db: AppDb, entry: AdminAuditEntry): Promise<void> {
  const now = Date.now();
  const changes = sanitizeChanges(entry.changes);
  try {
    await db.insert(adminAuditEvents).values({
      id: `aud_${randomUUID()}`,
      orgId: entry.orgId,
      actorUserId: entry.actor.userId,
      actorEmail: entry.actor.email,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId ?? null,
      targetName: entry.targetName ? sanitizeString(entry.targetName) : null,
      changes,
      ip: entry.actor.ip ? entry.actor.ip.slice(0, 100) : null,
      userAgent: entry.actor.userAgent ? entry.actor.userAgent.slice(0, 300) : null,
      createdAt: now,
    });
  } catch (err) {
    reportError(
      {
        area: "api",
        reason: "admin_audit_write",
        fields: { orgId: entry.orgId, action: entry.action, targetType: entry.targetType, targetId: entry.targetId ?? null, actorUserId: entry.actor.userId },
      },
      `The admin audit row for ${entry.action} was not written. The change took effect. Check database health, then review this change by hand.`,
      err,
    );
  }
  if (entry.alert) emitSecurityAlert(entry, entry.alert, changes, now);
}

// ── Read ────────────────────────────────────────────────────────────────────

export const ADMIN_AUDIT_PAGE_DEFAULT = 50;
export const ADMIN_AUDIT_PAGE_MAX = 200;

export interface AdminAuditCursor {
  createdAt: number;
  id: string;
}

/** One page, newest first, keyset on (created_at desc, id desc). Reads `limit + 1` rows at most. */
export async function listAdminAudit(
  db: AppDb,
  args: {
    orgId: string;
    limit: number;
    cursor?: AdminAuditCursor;
    targetType?: AdminAuditTargetType;
    actorUserId?: string;
  },
): Promise<{ rows: AdminAuditEventRow[]; next?: AdminAuditCursor }> {
  const limit = Math.max(1, Math.min(args.limit, ADMIN_AUDIT_PAGE_MAX));
  const where: SQL[] = [eq(adminAuditEvents.orgId, args.orgId)];
  if (args.targetType) where.push(eq(adminAuditEvents.targetType, args.targetType));
  if (args.actorUserId) where.push(eq(adminAuditEvents.actorUserId, args.actorUserId));
  if (args.cursor) {
    const after = or(
      lt(adminAuditEvents.createdAt, args.cursor.createdAt),
      and(eq(adminAuditEvents.createdAt, args.cursor.createdAt), lt(adminAuditEvents.id, args.cursor.id)),
    );
    if (after) where.push(after);
  }
  const rows = await db
    .select()
    .from(adminAuditEvents)
    .where(and(...where))
    .orderBy(desc(adminAuditEvents.createdAt), desc(adminAuditEvents.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return rows.length > limit && last ? { rows: page, next: { createdAt: last.createdAt, id: last.id } } : { rows: page };
}
