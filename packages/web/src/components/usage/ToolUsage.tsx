import { useEffect, useState } from "react";
import type { ExternalUsageResponse, UsagePeriodSelection, UsageScopeName } from "@valet/api/wire";
import { useExternalUsage } from "~/api/usage";
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, FilterChips, Input, Time } from "~/components/primitives";

const SURFACES = [{ id: "all", label: "All surfaces" }, { id: "hosted", label: "Hosted" }, { id: "mcp", label: "MCP" }, { id: "cli", label: "CLI" }] as const;
type Surface = (typeof SURFACES)[number]["id"];
const LABELS = { hosted: "Hosted", mcp: "MCP", cli: "CLI" };
const COLORS = { hosted: "fill-moss", mcp: "fill-accent-500", cli: "fill-muted" };

function CallsChart({ daily }: { daily: ExternalUsageResponse["daily"] }) {
  const days = [...new Set(daily.map(d => d.dayMs))];
  const max = Math.max(1, ...daily.map(d => d.calls));
  return <svg width="100%" height={160} role="img" aria-label="Daily tool calls by surface">
    <line x1="0" x2="100%" y1={126} y2={126} className="stroke-line" />
    {days.map((day, i) => <g key={day}>
      {(["hosted", "mcp", "cli"] as const).map((surface, j) => {
        const calls = daily.find(d => d.dayMs === day && d.surface === surface)?.calls ?? 0;
        const height = calls ? Math.max(2, calls / max * 110) : 0;
        return <rect key={surface} x={`${(i + 0.5) / days.length * 100}%`} transform={`translate(${(j - 1) * 8 - 3}, 0)`}
          y={126 - height} width={6} height={height} rx={2} className={COLORS[surface]}>
          <title>{new Date(day).toISOString().slice(0, 10)} · {LABELS[surface]}: {calls} calls</title>
        </rect>;
      })}
      {(i % Math.max(1, Math.ceil(days.length / 5)) === 0 || i === days.length - 1) &&
        <text x={`${(i + 0.5) / days.length * 100}%`} y={151} textAnchor="middle" className="fill-muted text-xs">
          {new Date(day).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })}
        </text>}
    </g>)}
  </svg>;
}

export function ToolUsage({ period, scope, teamId }: { period: UsagePeriodSelection; scope: UsageScopeName; teamId?: string }) {
  const [surface, setSurface] = useState<Surface>("all");
  const [input, setInput] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const periodKey = JSON.stringify(period);
  useEffect(() => { setOffset(0); }, [scope, teamId, periodKey]);
  useEffect(() => {
    const timer = setTimeout(() => { setSearch(input); setOffset(0); }, 250);
    return () => clearTimeout(timer);
  }, [input]);
  const query = useExternalUsage(period, scope, teamId, search, offset, surface === "all" ? undefined : surface);
  const data = query.data;
  const total = data?.daily.reduce((sum, day) => sum + day.calls, 0) ?? 0;

  return <section aria-label="Tool usage" className="space-y-5 min-w-0">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div><h2 className="text-base font-semibold text-ink">Tool usage</h2>
        <p className="mt-1 text-sm text-muted">What people ask Valet to do, across the hosted assistant, MCP, and CLI.</p>
        <p className="mt-1 text-xs text-muted">Sandbox file and shell tools are excluded. Arguments and results are not collected.</p>
      </div>
      <FilterChips options={SURFACES.map(s => ({ value: s.id, label: s.label }))} value={surface} onChange={value => { setSurface(value); setOffset(0); }} label="Tool surface" />
    </div>
    {query.isPending ? <div role="status" className="rounded-lg border border-line p-8 text-sm text-muted">Loading tool usage…</div>
      : query.isError ? <div role="alert" className="rounded-lg border border-line p-5 text-sm text-danger-600">Tool usage could not load. <Button size="sm" variant="ghost" onClick={() => void query.refetch()}>Try again</Button></div>
      : data && <>
        <Card><CardHeader className="flex items-center justify-between gap-3"><CardTitle>Calls over time</CardTitle>
          <span className="text-sm tabular-nums text-muted">{total.toLocaleString()} {total === 1 ? "call" : "calls"}</span></CardHeader>
          <CardBody>{total === 0 ? <p className="py-8 text-center text-sm text-muted">No tool calls in this window.</p> : <>
            <CallsChart daily={data.daily} />
            <div className="flex justify-end gap-4 text-xs text-muted">{SURFACES.slice(1).map(s => <span key={s.id} className="inline-flex items-center gap-1.5"><svg width="8" height="8" aria-hidden><circle cx="4" cy="4" r="4" className={COLORS[s.id === "all" ? "hosted" : s.id]} /></svg>{s.label}</span>)}</div>
          </>}</CardBody></Card>
        <div className="grid min-w-0 grid-cols-1 gap-5 lg:grid-cols-3">
          <Card className="min-w-0 lg:col-span-2"><CardHeader><CardTitle>Top tools & commands</CardTitle></CardHeader>
            {data.tools.length === 0 ? <CardBody><p className="text-sm text-muted">No tools or commands yet.</p></CardBody> :
              <div className="overflow-x-auto"><table className="w-full text-sm"><thead className="bg-paper-muted text-xs text-muted"><tr>
                <th className="px-5 py-3 text-left font-medium">Tool / command</th><th className="px-3 py-3 text-right font-medium">Calls</th>
                <th className="px-3 py-3 text-right font-medium">Error rate</th><th className="px-5 py-3 text-right font-medium">Users</th>
              </tr></thead><tbody>{data.tools.map(row => <tr key={`${row.surface}:${row.name}`} className="border-t border-line hover:bg-ink-wash">
                <td className="px-5 py-3"><div className="break-all font-medium text-ink">{row.name}</div><div className="mt-1 text-xs text-muted">{LABELS[row.surface]}</div></td>
                <td className="px-3 py-3 text-right tabular-nums">{row.calls.toLocaleString()}</td>
                <td className="px-3 py-3 text-right tabular-nums text-muted">{(row.errorRate * 100).toFixed(1)}%</td>
                <td className="px-5 py-3 text-right tabular-nums text-muted">{row.uniqueUsers.toLocaleString()}</td>
              </tr>)}</tbody></table></div>}
          </Card>
          <Card className="min-w-0"><CardHeader><CardTitle>Top clients</CardTitle></CardHeader>
            <CardBody>{data.clients.length === 0 ? <p className="text-sm text-muted">No clients in this window.</p> :
              <ul className="divide-y divide-line">{data.clients.map(row => <li key={`${row.surface}:${row.name}:${row.version}`} className="flex items-start justify-between gap-3 py-3 first:pt-0 last:pb-0">
                <div className="min-w-0"><p className="break-all text-sm font-medium text-ink">{row.name}</p><p className="mt-1 break-all text-xs text-muted">{LABELS[row.surface]} · {row.version ?? "Version not reported"}</p></div>
                <span className="text-sm tabular-nums text-muted">{row.calls.toLocaleString()}</span>
              </li>)}</ul>}</CardBody>
          </Card>
        </div>
        {data.detailsVisible ? <Card><CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle>Recent intents</CardTitle><Input size="sm" className="w-full sm:w-72" aria-label="Search intents" placeholder="Search intents…" value={input} maxLength={500} onChange={e => setInput(e.target.value)} />
        </CardHeader>
          {data.recent.length === 0 ? <CardBody><p className="text-sm text-muted">{search ? "No intents match your search." : "No recent intents in this window."}</p></CardBody> :
            <ul className="divide-y divide-line">{data.recent.map(row => <li key={row.id} className="px-5 py-4">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted">
                <span className="break-all font-medium text-ink">{row.name}</span><Badge variant={row.outcome === "ok" ? "success" : row.outcome === "denied" ? "warning" : "danger"}>{row.outcome}</Badge>
                <span>{LABELS[row.surface]}</span><Time ts={row.createdAt} className="sm:ml-auto" />
              </div>
              <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed text-ink">{row.intent ?? (row.intentCleared ? "Intent cleared after 90 days." : row.surface === "cli" ? "CLI commands do not require intent." : "No valid intent was supplied.")}</p>
              <p className="mt-2 break-all text-xs text-muted">{row.userName ?? row.userId ?? row.teamName ?? "Automation"} · {row.clientName ?? "Hosted Valet"}{row.clientVersion ? ` ${row.clientVersion}` : ""}</p>
            </li>)}</ul>}
          <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-3">
            <span className="text-xs text-muted">Page {Math.floor(offset / 20) + 1}</span><div className="flex gap-2">
              <Button size="sm" variant="ghost" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 20))}>Previous</Button>
              <Button size="sm" variant="ghost" disabled={!data.hasMore} onClick={() => setOffset(offset + 20)}>Next</Button>
            </div>
          </div>
        </Card> : <p className="text-sm text-muted">Only team admins can see individual intents.</p>}
      </>}
  </section>;
}
