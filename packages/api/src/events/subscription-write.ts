/**
 * The ONE gate in front of every `event_subscriptions` write. It validates
 * the body against the merged plugin catalog and applies the catalog-declared
 * scope rules (TKAI-299/TKAI-302, `subscription-scope.ts`). Writers must call
 * `validateSubscriptionWrite` — never `validateSubscription` alone — so a new
 * writer cannot ship the unscoped back door this gate exists to close.
 * Current writers: the subscriptions CRUD routes (`routes/events.ts`), the
 * workflow trigger service (`workflows/trigger-service.ts`), and the template
 * installer (`workflows/templates.ts`).
 */
import type { EventCatalogEntry, ValetPlugin } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { allCatalogEntries } from "./ingest.js";
import { validateRegexPattern, type SubscriptionFilter } from "./match.js";
import { enforceSubscriptionScope } from "./subscription-scope.js";

const FILTER_OPS = ["eq", "in", "prefix", "contains", "regex"] as const;
// `signal` (wake parked workflow runs) is deliberately NOT accepted yet:
// no workflow node parks on the `event:{key}` signal shape the dispatcher
// would emit, so a signal-target subscription would validate and then
// silently never fire. Re-add once a waitForEvent node exists.
const TARGET_KINDS = ["workflow", "orchestrator"] as const;

/**
 * Validates a subscription body against the merged plugin catalog. Returns a
 * human-readable error naming the offending key/field/op, or `null` when
 * valid. Shared by POST (full body) and PATCH (existing row merged with the
 * patch, so partial updates re-validate in context). Workflow-target org
 * ownership is checked separately by the POST handler (needs the db).
 */
export function validateSubscription(
  plugins: ValetPlugin[],
  body: {
    name: unknown;
    eventKeys: unknown;
    filters: unknown;
    target: unknown;
  },
): string | null {
  const entries = allCatalogEntries(plugins);

  if (typeof body.name !== "string" || body.name.length === 0) {
    return "name must be a non-empty string";
  }

  if (!Array.isArray(body.eventKeys) || body.eventKeys.length === 0) {
    return "eventKeys must be a non-empty array";
  }
  // Catalog entries actually selected by the eventKeys patterns — filter
  // fields are validated against THESE, not the union across all services,
  // because the ingest matcher (`match.ts` filtersMatch) only consults the
  // arriving event's own entry. Validating against the union would accept
  // e.g. a GitHub-only `repo` filter on a `linear.issue.*` subscription,
  // which then silently never matches anything.
  const selectedEntries: EventCatalogEntry[] = [];
  for (const pattern of body.eventKeys) {
    if (typeof pattern !== "string" || pattern.length === 0) {
      return "eventKeys entries must be non-empty strings";
    }
    const matches = pattern.endsWith(".*")
      ? entries.filter((e) => e.key.startsWith(pattern.slice(0, -1)))
      : entries.filter((e) => e.key === pattern);
    if (matches.length === 0) return `unknown event key: ${pattern}`;
    selectedEntries.push(...matches);
  }

  if (!Array.isArray(body.filters)) {
    return "filters must be an array";
  }
  for (const raw of body.filters) {
    if (typeof raw !== "object" || raw === null) return "filters entries must be objects";
    const f = raw as Record<string, unknown>;
    if (typeof f.field !== "string" || f.field.length === 0) {
      return "filter field must be a non-empty string";
    }
    if (typeof f.op !== "string" || !(FILTER_OPS as readonly string[]).includes(f.op)) {
      return `unknown filter op: ${String(f.op)}`;
    }
    if (f.op === "in") {
      if (
        !Array.isArray(f.value) ||
        (f.value as unknown[]).some((v) => typeof v !== "string")
      ) {
        return `filter value invalid for op in on field ${f.field}`;
      }
    } else {
      // eq / prefix / contains / regex — value must be a non-empty string
      if (typeof f.value !== "string" || f.value.length === 0) {
        return `filter value invalid for op ${f.op} on field ${f.field}`;
      }
      // A regex runs on every event, so refuse an invalid, oversized, or
      // catastrophic-backtracking pattern at write time (see match.ts).
      if (f.op === "regex") {
        const regexError = validateRegexPattern(f.value);
        if (regexError) return regexError;
      }
    }
    if (!selectedEntries.some((e) => e.filters.some((cf) => cf.field === f.field))) {
      return `filter field ${f.field} is not declared by any event selected by eventKeys`;
    }
  }

  if (typeof body.target !== "object" || body.target === null) {
    return "target must be an object";
  }
  const target = body.target as Record<string, unknown>;
  if (typeof target.kind !== "string" || !(TARGET_KINDS as readonly string[]).includes(target.kind)) {
    return `unknown target kind: ${String(target.kind)}`;
  }
  if (target.kind === "workflow" && (typeof target.workflowId !== "string" || target.workflowId.length === 0)) {
    return "workflow target requires workflowId";
  }
  if (target.kind === "orchestrator") {
    const who = target.orchestrator;
    if (who !== undefined && who !== "user" && who !== "team" && who !== "org") {
      return `unknown target orchestrator: ${String(who)}`;
    }
    // `orchestrator` and `teamId` are one choice expressed in two fields, so
    // each is refused without the other. A team target with no id names no
    // team; a teamId on a user or org target names a team the delivery would
    // never reach, and would read as if it did.
    if (who === "team" && (typeof target.teamId !== "string" || target.teamId.length === 0)) {
      return "team orchestrator target requires teamId";
    }
    if (who !== "team" && target.teamId !== undefined) {
      return "teamId is only valid when orchestrator is team";
    }
  }
  return null;
}

export interface SubscriptionWriteScope {
  /** The subscription's creator (`created_by`) — the caller on create, the
   * row's own creator on patch. */
  creatorUserId: string;
  /** The request's explicit any-channel opt-out. */
  anyChannel: boolean;
  /** Whether this write changes what the subscription matches. Creates always
   * pass true. Patches pass whether `eventKeys` or `filters` were provided —
   * false skips the scope gate, so a rename or an enable toggle is not
   * blocked by a creator who unlinked Slack after the row was scoped. */
  matchChanged: boolean;
  /** Patches only: the row's derived any-channel state
   * (`storedAnyChannelState`), so an edit that leaves channel scope alone
   * needs no re-asserted flag. */
  storedAnyChannel?: boolean;
}

/**
 * Validate + scope one subscription write. Returns the filters to store —
 * the validated input plus any filter the mention gate injected — or the
 * refusal to answer with. The casts narrow shapes `validateSubscription`
 * just accepted.
 */
export async function validateSubscriptionWrite(
  db: AppDb,
  plugins: ValetPlugin[],
  body: { name: unknown; eventKeys: unknown; filters: unknown; target: unknown },
  scope: SubscriptionWriteScope,
): Promise<{ ok: true; filters: SubscriptionFilter[] } | { ok: false; error: string }> {
  const error = validateSubscription(plugins, body);
  if (error) return { ok: false, error };
  const filters = body.filters as SubscriptionFilter[];
  if (!scope.matchChanged) return { ok: true, filters };
  return enforceSubscriptionScope(db, plugins, scope.creatorUserId, {
    eventKeys: body.eventKeys as string[],
    filters,
    anyChannel: scope.anyChannel,
    storedAnyChannel: scope.storedAnyChannel,
  });
}
