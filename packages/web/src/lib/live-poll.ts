/**
 * The poll interval for a query whose response says whether work is still
 * moving. `undefined` data means the first fetch has not landed; that fetch
 * is already in flight, so no timer is needed. Once nothing moves, polling
 * stops until something re-activates the query.
 */
export function livePollInterval<TData>(
  data: TData | undefined,
  isLive: (data: TData) => boolean,
  intervalMs: number,
): number | false {
  if (data === undefined) return false;
  return isLive(data) ? intervalMs : false;
}
