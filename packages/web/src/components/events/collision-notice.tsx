/**
 * CollisionNotice — the existing rules a subscription write collides with
 * (TKAI-294). The server refuses a write that covers an existing enabled
 * rule (409 with a `collisions` payload) and commits a partial overlap with
 * the same payload as a warning. Either way the person saving the rule sees
 * what they are about to step on: each colliding line's name (a link to its
 * page), owner, and sentence.
 */
import { Link } from "@tanstack/react-router";
import type {
  EventSubscriptionCollisionsWire,
  EventSubscriptionCollisionWire,
} from "@valet/api/wire";
import { ApiError } from "~/api/client";
import { Badge } from "~/components/primitives";
import { presenceSentence } from "~/components/presence/sentences";

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

function ownerLabel(ownerType: "user" | "team" | "org"): string {
  if (ownerType === "org") return "Org";
  if (ownerType === "team") return "Team";
  return "Personal";
}

/**
 * One colliding line: its name (a link to its page), its owner, and its
 * sentence. The badge says `Would replace` only for the line this one
 * replaces (the proposal's `replaces` id, which the server turns off when
 * this one turns on). Every other line keeps firing: `Also fires`.
 */
function CollisionRow({ collision, replaces }: { collision: EventSubscriptionCollisionWire; replaces: string | undefined }) {
  const sub = collision.subscription;
  const replaced = replaces !== undefined && sub.id === replaces;
  return (
    <li className="min-w-0 py-1">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
        <Badge variant={replaced ? "danger" : "warning"} className="shrink-0">
          {replaced ? "Would replace" : "Also fires"}
        </Badge>
        <Link to="/presence/rules/$id" params={{ id: sub.id }} className="truncate text-sm font-medium text-ink underline-offset-2 hover:underline">
          {sub.name}
        </Link>
        <Badge variant="neutral" className="shrink-0">
          {ownerLabel(sub.ownerType)}
        </Badge>
      </div>
      <p className="mt-0.5 text-xs text-muted">{presenceSentence(sub, undefined, [], {})}</p>
    </li>
  );
}

/**
 * `committed: false` — the write was refused; the caller may offer an
 * explicit "create anyway". `committed: true` — the rule was saved and this
 * is the overlap warning that rode back with it. `intent` names the caller's
 * verb: "create" for the wizard, "save" for the edit dialog, so the notice
 * never says "Created." after a PATCH.
 */
export function CollisionNotice({
  report,
  committed,
  intent = "create",
  replaces,
}: {
  report: EventSubscriptionCollisionsWire;
  committed: boolean;
  intent?: "create" | "save";
  /** The id of the line this one replaces, from a proposal's `target.replaces`. */
  replaces?: string;
}) {
  const blocked = report.blocking.length > 0 && !committed;
  const onlyReplaced = report.blocking.length > 0 && report.blocking.every((c) => c.subscription.id === replaces);
  return (
    <div
      className={`rounded border px-3 py-2 ${
        blocked ? "border-danger-500/50" : "border-line bg-ink-wash/40"
      }`}
    >
      <p className="text-xs font-medium text-ink">
        {committed
          ? `${intent === "save" ? "Saved" : "Created"}. These also fire for the same events:`
          : onlyReplaced
            ? "Not saved: this covers everything the line it replaces covers."
            : report.blocking.length > 0
              ? "Not saved: these already handle everything this covers. All of them would fire together."
              : "This overlaps with what Valet already does:"}
      </p>
      <ul className="mt-1 divide-y divide-line/60">
        {[...report.blocking, ...report.overlapping].map((c) => (
          <CollisionRow key={c.subscription.id} collision={c} replaces={replaces} />
        ))}
      </ul>
      {blocked && (
        <p className="mt-1 text-xs text-muted">
          {onlyReplaced
            ? `To turn the replaced line off, ${intent === "save" ? "save" : "create"} it anyway.`
            : <>Narrow the channels or filters so they stay separate, or{" "}
              {intent === "save" ? "save" : "create"} it anyway to accept the double delivery.</>}
        </p>
      )}
    </div>
  );
}
