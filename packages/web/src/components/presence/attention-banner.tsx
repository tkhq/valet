/**
 * The **Needs attention** banner (docs/specs/2026-10-16-presence-hub-design.md
 * Part B step 2, Part F step 4, INV-H6): a ruled section with a danger mark
 * and a muted heading. Each fault is one item with its fix inline, and a
 * line's fault names its place first (`In acme/api,`): an archived pin shows the thread picker, which is the same
 * `ThreadProblem` the sentence row shows; a routine that is off shows its
 * reason and an `Edit` link; a dead delivery links its event. The banner
 * never shows a bare count, and it shows nothing when there is no fault.
 */
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import type { EventSubscriptionWire } from "@valet/api/wire";
import { usePatchEventSubscription } from "~/api/events";
import { usePinnedThreadTitle } from "~/api/rule";
import { useMe } from "~/api/settings";
import { textLinkClass } from "~/components/primitives";
import { errorText } from "~/lib/error-text";
import { ThreadProblem } from "./problem-badge";
import { lineReadOnly, lineWorkspace, pinnedTitle, storedPolicy } from "./presence-rows";
import type { Fault } from "./use-faults";

/** A stable key per fault: one fault per line, routine, or line's dead delivery. */
function faultKey(fault: Fault): string {
  if (fault.kind === "line") return `line:${fault.sub.id}`;
  if (fault.kind === "routine") return `routine:${fault.routine.id}`;
  return `delivery:${fault.subscriptionId}`;
}

export function AttentionBanner({ faults }: { faults: Fault[] }) {
  if (faults.length === 0) return null;
  return (
    <section aria-labelledby="presence-attention" className="border-t border-line pt-3.5">
      <h2 id="presence-attention" className="flex items-center gap-2 text-xs font-medium text-muted">
        <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-danger-500" />
        Needs attention
      </h2>
      <ul className="mt-2.5 space-y-3">
        {faults.map((fault) => (
          <li key={faultKey(fault)} className="min-w-0 text-sm">
            <FaultItem fault={fault} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function FaultItem({ fault }: { fault: Fault }) {
  if (fault.kind === "line") return <LineFault sub={fault.sub} place={fault.place} />;
  if (fault.kind === "routine") {
    return (
      <p className="flex flex-wrap items-baseline gap-x-2 [overflow-wrap:anywhere]">
        <span className="text-danger-600 dark:text-danger-500">{fault.text}</span>
        <Link to="/presence/routines/$id" params={{ id: fault.routine.id }} className={textLinkClass}>Edit</Link>
      </p>
    );
  }
  return (
    <Link to="/presence/events/$eventId" params={{ eventId: fault.eventId }} className="text-danger-600 [overflow-wrap:anywhere] hover:underline dark:text-danger-500">
      {fault.text}
    </Link>
  );
}

/** A line with a problem: the problem text and its fix, as under the line's row. */
function LineFault({ sub, place }: { sub: EventSubscriptionWire; place: string | undefined }) {
  const me = useMe();
  const patch = usePatchEventSubscription();
  const titles = usePinnedThreadTitle(storedPolicy(sub));
  const [error, setError] = useState<string | null>(null);
  return (
    <ThreadProblem
      variant="inline"
      lead={place === undefined ? undefined : `In ${place},`}
      problem={sub.problem ?? ""}
      threadTitle={pinnedTitle(sub, titles)}
      workspace={lineWorkspace(sub)}
      readOnly={lineReadOnly(sub, me.data?.id)}
      pending={patch.isPending}
      error={error}
      onPick={(thread) => {
        setError(null);
        patch.mutate({ id: sub.id, body: { thread } }, { onError: (err) => setError(errorText(err)) });
      }}
    />
  );
}
