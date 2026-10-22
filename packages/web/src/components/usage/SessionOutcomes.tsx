import type { UsagePeriodSelection, UsageScopeName } from "@valet/api/wire";
import { useSessionOutcomeUsage } from "~/api/usage";
import { Button, Card, CardBody, CardHeader, CardTitle } from "~/components/primitives";

export function SessionOutcomes({ period, scope, teamId }: { period: UsagePeriodSelection; scope: UsageScopeName; teamId?: string }) {
  const query = useSessionOutcomeUsage(period, scope, teamId);
  const total = query.data?.outcomes.reduce((sum, row) => sum + row.sessions, 0) ?? 0;
  return <Card><CardHeader><CardTitle>Session outcomes</CardTitle></CardHeader><CardBody>
    <p className="mb-4 text-xs text-muted">Latest classified outcome for each chat session, classified in this period. Updated when work stops or waits for a person.</p>
    {query.isPending ? <p role="status" className="text-sm text-muted">Loading session outcomes…</p>
      : query.isError ? <p role="alert" className="text-sm text-danger-600">Session outcomes could not load. <Button size="sm" variant="ghost" onClick={() => void query.refetch()}>Try again</Button></p>
      : total === 0 ? <p className="text-sm text-muted">No classified sessions in this window.</p>
      : <dl className="grid grid-cols-2 gap-3 lg:grid-cols-3">{query.data?.outcomes.map(row => <div key={row.key} className="rounded-lg border border-line p-3" title={row.definition}>
        <dt className="text-xs text-muted">{row.label}</dt><dd className="mt-1 text-lg font-semibold tabular-nums text-ink">{row.sessions.toLocaleString()}</dd>
      </div>)}</dl>}
  </CardBody></Card>;
}
