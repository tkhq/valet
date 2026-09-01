/**
 * CollisionNotice — the existing rules a subscription write collides with
 * (TKAI-294). The server refuses a write that covers an existing enabled
 * rule (409 with a `collisions` payload) and commits a partial overlap with
 * the same payload as a warning. Either way the person saving the rule sees
 * what they are about to step on: each colliding rule's name, owner, target
 * kind, and filter summary.
 */
import type {
  EventSubscriptionCollisionsWire,
  EventSubscriptionCollisionWire,
  EventSubscriptionFilterWire,
} from "@valet/api/wire";
import { ApiError } from "~/api/client";
import { Badge } from "~/components/primitives";

/** The collision payload of a blocked (409) subscription write, or null when
 * the failure is not one. */
export function collisionsFromError(err: unknown): EventSubscriptionCollisionsWire | null {
  if (!(err instanceof ApiError)) return null;
  const payload = err.payload;
  if (typeof payload !== "object" || payload === null || !("collisions" in payload)) return null;
  const collisions = (payload as { collisions: unknown }).collisions;
  if (typeof collisions !== "object" || collisions === null) return null;
  const report = collisions as { blocking?: unknown; overlapping?: unknown };
  if (!Array.isArray(report.blocking) || !Array.isArray(report.overlapping)) return null;
  return collisions as EventSubscriptionCollisionsWire;
}

function opWord(op: EventSubscriptionFilterWire["op"]): string {
  switch (op) {
    case "eq":
      return "is";
    case "in":
      return "is one of";
    case "prefix":
      return "starts with";
    case "contains":
      return "contains";
    case "regex":
      return "matches";
  }
}

/** One filter as words, preferring the stored display labels over raw ids. */
function describeFilter(f: EventSubscriptionFilterWire): string {
  const value = Array.isArray(f.value)
    ? (f.labels ?? f.value).join(", ")
    : (f.label ?? f.value);
  return `${f.field} ${opWord(f.op)} ${value}`;
}

function describeTargetKind(kind: string): string {
  return kind === "workflow" ? "runs a workflow" : "notifies an assistant";
}

function ownerLabel(ownerType: "user" | "team" | "org"): string {
  if (ownerType === "org") return "Org";
  if (ownerType === "team") return "Team";
  return "Personal";
}

function CollisionRow({ collision, blocking }: { collision: EventSubscriptionCollisionWire; blocking: boolean }) {
  const sub = collision.subscription;
  const filters = sub.filters.map(describeFilter).join(", and ");
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 py-1">
      <Badge variant={blocking ? "danger" : "warning"} className="shrink-0">
        {blocking ? "Would replace" : "Overlaps"}
      </Badge>
      <span className="truncate text-sm font-medium text-ink">{sub.name}</span>
      <Badge variant="neutral" className="shrink-0">
        {ownerLabel(sub.ownerType)}
      </Badge>
      <span className="text-xs text-muted">
        {describeTargetKind(sub.target.kind)}
        {filters ? ` · ${filters}` : " · no filters"}
        {` · ${collision.sharedKeys.join(", ")}`}
      </span>
    </li>
  );
}

/**
 * `committed: false` — the write was refused; the caller may offer an
 * explicit "create anyway". `committed: true` — the rule was saved and this
 * is the overlap warning that rode back with it.
 */
export function CollisionNotice({
  report,
  committed,
}: {
  report: EventSubscriptionCollisionsWire;
  committed: boolean;
}) {
  const blocked = report.blocking.length > 0 && !committed;
  return (
    <div
      className={`rounded border px-3 py-2 ${
        blocked ? "border-danger-500/50" : "border-line bg-ink-wash/40"
      }`}
    >
      <p className="text-xs font-medium text-ink">
        {committed
          ? "Created. This rule fires alongside existing rules:"
          : report.blocking.length > 0
            ? "Not saved: this rule covers everything these rules already handle. All of them would fire together."
            : "This rule overlaps with existing rules:"}
      </p>
      <ul className="mt-1 divide-y divide-line/60">
        {report.blocking.map((c) => (
          <CollisionRow key={c.subscription.id} collision={c} blocking />
        ))}
        {report.overlapping.map((c) => (
          <CollisionRow key={c.subscription.id} collision={c} blocking={false} />
        ))}
      </ul>
      {blocked && (
        <p className="mt-1 text-xs text-muted">
          Narrow the channels or filters so the rules stay separate, or create it anyway to
          accept the double delivery.
        </p>
      )}
    </div>
  );
}
