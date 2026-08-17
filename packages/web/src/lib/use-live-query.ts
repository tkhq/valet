/**
 * One polling policy for list queries whose rows carry a run state.
 *
 * A background-agent product has one list the user leaves open on a second
 * monitor. That list must follow the work without a WebSocket for every
 * page, and it must cost nothing when there is no work. A fixed
 * `refetchInterval` gives one of those two, never both: a short period
 * hammers the API for a list of finished rows, and a long period makes a
 * live row look stuck.
 *
 * `useLiveQuery` reads the answer out of the query's OWN last response.
 * The caller supplies `isLive`, which looks at the rows and says whether
 * anything is still moving. While it holds, the query polls every
 * `intervalMs`. As soon as the response comes back with nothing moving,
 * the poll stops — no timer, no request, until something re-activates the
 * query.
 *
 * Two library defaults complete the policy and are load-bearing:
 *
 *  - `refetchIntervalInBackground` stays false, so a hidden tab does not
 *    poll at all. The cost of an open-but-unwatched list is zero.
 *  - `refetchOnWindowFocus` is set true here. It is the other half of the
 *    same rule: the return to the tab refetches at once, so the user never
 *    reads a frame of state from before they looked away.
 *
 * DO NOT apply this wrapper to `useMessages`. That hook disables
 * `refetchOnWindowFocus` and `refetchOnReconnect` on purpose: a background
 * refetch there calls `setThreadMessages` and can wipe in-flight optimistic
 * and streamed state. This wrapper turns focus refetching back on, so it
 * would restore exactly that bug. It suits LIST queries — sessions today;
 * the workflow and event lists can adopt it — not the message thread.
 */
import { useQuery, type UseQueryOptions } from "@tanstack/react-query";

/**
 * Poll period while a list has work in flight. Matches the workflow
 * run-detail poll in `api/workflows.ts`, so the product refreshes at one
 * cadence instead of one per page.
 */
export const LIVE_POLL_MS = 5_000;

export interface LiveQueryOptions<TData> extends UseQueryOptions<TData> {
  /**
   * Reads the last response and answers "is anything still moving?".
   * True keeps the poll running. False stops it.
   */
  isLive: (data: TData) => boolean;
  /** Poll period in ms while `isLive` holds. Defaults to `LIVE_POLL_MS`. */
  intervalMs?: number;
}

/**
 * The policy itself, as a pure function of the last response. `undefined`
 * data means the first fetch has not landed; that fetch is already in
 * flight, so no timer is needed.
 */
export function livePollInterval<TData>(
  data: TData | undefined,
  isLive: (data: TData) => boolean,
  intervalMs: number,
): number | false {
  if (data === undefined) return false;
  return isLive(data) ? intervalMs : false;
}

export function useLiveQuery<TData>({
  isLive,
  intervalMs = LIVE_POLL_MS,
  ...options
}: LiveQueryOptions<TData>) {
  return useQuery<TData>({
    ...options,
    // The policy comes after the caller's options on purpose. The point of
    // this wrapper is that ONE rule decides the cadence, so a stray
    // `refetchInterval` from a caller cannot quietly replace it.
    refetchInterval: (query) => livePollInterval(query.state.data, isLive, intervalMs),
    refetchOnWindowFocus: true,
  });
}
