/**
 * The **All listeners** view of the Places tab
 * (docs/specs/2026-10-16-presence-hub-design.md Part B step 4): every
 * listener of the workspace in one flat table, each row its Part C sentence.
 * A listener that spans several channels is one row.
 */
import { Link } from "@tanstack/react-router";
import { useEventSubscriptions } from "~/api/events";
import { EmptyRow, ErrorRow, LoadingRow } from "~/components/primitives";
import { useListOwner } from "~/lib/use-list-owner";
import { errorText } from "~/lib/error-text";
import { PausedBadge, useListenerSentence } from "./listener-rows";
import { ProblemBadge } from "./problem-badge";

export function AllListenersTable() {
  const owner = useListOwner();
  // Wait for the owner: an unscoped read lists every workspace's listeners.
  const subscriptions = useEventSubscriptions(owner, { enabled: owner !== undefined });
  const listeners = subscriptions.data?.subscriptions ?? [];
  const sentence = useListenerSentence(listeners);

  if (subscriptions.isPending) return <LoadingRow label="Loading listeners…" />;
  if (subscriptions.isError) {
    return <ErrorRow>{errorText(subscriptions.error, "Could not load listeners. Reload the page to try again.")}</ErrorRow>;
  }
  if (listeners.length === 0) {
    return <EmptyRow>This workspace has no listeners yet. Select New listener to add one.</EmptyRow>;
  }
  return (
    <div className="max-w-full overflow-x-auto rounded-lg border border-line">
      <table aria-label="All listeners" className="w-full text-sm">
        <thead>
          <tr className="border-b border-line bg-paper-muted">
            <th scope="col" className="px-3 py-2 text-left font-medium text-muted">Name</th>
            <th scope="col" className="px-3 py-2 text-left font-medium text-muted">Listener</th>
            <th scope="col" className="px-3 py-2 text-left font-medium text-muted">Status</th>
          </tr>
        </thead>
        <tbody>
          {listeners.map((sub) => (
            <tr key={sub.id} className="border-b border-line last:border-0">
              <td className="px-3 py-2 align-top text-ink">
                <Link to="/presence/rules/$id" params={{ id: sub.id }} className="hover:underline">{sub.name}</Link>
              </td>
              <td className="px-3 py-2 align-top text-ink [overflow-wrap:anywhere]">{sentence(sub)}</td>
              <td className="px-3 py-2 align-top">
                <span className="inline-flex flex-wrap items-center gap-1">
                  {sub.enabled ? <span className="text-muted">On</span> : <PausedBadge sub={sub} />}
                  <ProblemBadge problem={sub.problem} />
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
