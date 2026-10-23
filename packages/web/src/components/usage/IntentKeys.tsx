import type { ToolIntentKeyUsage, ToolIntentUsage } from "@valet/api/wire";
import { useEditTagKey, useMergeTagKey } from "~/api/tagging";
import { Badge, Button, Card, CardHeader, CardTitle, CardBody, Input, Select } from "~/components/primitives";

function KeyEditor({ row, keys }: { row: ToolIntentKeyUsage; keys: ToolIntentKeyUsage[] }) {
  const edit = useEditTagKey();
  const merge = useMergeTagKey();
  return <details className="mt-2"><summary className="cursor-pointer text-xs text-muted">Manage key</summary>
    <form className="mt-3 space-y-2" onSubmit={event => {
      event.preventDefault(); const data = new FormData(event.currentTarget);
      edit.mutate({ key: row.key, label: String(data.get("label")), definition: String(data.get("definition")) });
    }}>
      <label className="block text-xs text-muted">Label<Input name="label" required maxLength={100} defaultValue={row.label} /></label>
      <label className="block text-xs text-muted">Definition<Input name="definition" required maxLength={1000} defaultValue={row.definition} /></label>
      <Button type="submit" size="sm" disabled={edit.isPending}>Save key</Button>
    </form>
    {row.key !== "other" && <form className="mt-3 flex flex-wrap items-center gap-2" onSubmit={event => {
      event.preventDefault(); const data = new FormData(event.currentTarget); merge.mutate({ key: row.key, into: String(data.get("into")) });
    }}>
      <label className="text-xs text-muted">Merge into <Select name="into" aria-label={`Merge ${row.label} into`} defaultValue="other">
        {keys.filter(key => key.status !== "merged" && key.key !== row.key).map(key => <option key={key.key} value={key.key}>{key.label}</option>)}
      </Select></label>
      <Button type="submit" size="sm" disabled={merge.isPending}>Merge key</Button>
    </form>}
    {(edit.isError || merge.isError) && <p role="alert" className="mt-2 text-xs text-danger-600">The registry could not be changed. Reload it and retry after the current tagging batch.</p>}
    {(edit.isSuccess || merge.isSuccess) && <p role="status" className="mt-2 text-xs text-muted">Registry updated.</p>}
  </details>;
}

export function IntentKeys({ data, selected, onSelect }: { data: ToolIntentUsage; selected: string; onSelect: (key: string) => void }) {
  const active = data.keys.filter(key => key.status !== "merged" && (data.canManage || key.status !== "provisional"));
  const emerging = active.filter(key => key.status === "provisional");
  const bars = active.filter(key => key.status === "active" && key.calls > 0).map(key => ({ key: key.key, label: key.label, calls: key.calls }));
  const emergingCalls = data.emergingCalls ?? emerging.reduce((sum, key) => sum + key.calls, 0);
  if (emergingCalls) bars.push({ key: "__emerging", label: "Emerging", calls: emergingCalls });
  if (data.unlabeledCalls) bars.push({ key: "__unlabeled", label: "Unlabeled", calls: data.unlabeledCalls });
  bars.sort((a, b) => b.calls - a.calls);
  const max = Math.max(1, ...bars.map(bar => bar.calls));
  return <Card className="min-w-0"><CardHeader className="flex flex-wrap items-center justify-between gap-3"><CardTitle>Purpose of tool calls</CardTitle>
    {selected && <Button size="sm" variant="ghost" onClick={() => onSelect("")}>Clear key filter</Button>}
  </CardHeader><CardBody>
    <p className="mb-4 text-xs text-muted">Keys are assigned automatically. New keys stay emerging until five assignments or two distinct users.</p>
    {data.consolidationDue && <p role="status" className="mb-4 text-sm text-warning-600">Consolidation due. An organization admin can merge overlapping keys to make room.</p>}
    {bars.length === 0 ? <p className="py-5 text-sm text-muted">No tagged calls in this window. Queued calls appear after classification.</p> :
      <div role="group" aria-label="Tool calls by intent key" className="space-y-2">{bars.map(bar => <button type="button" key={bar.key} onClick={() => onSelect(bar.key)} aria-pressed={selected === bar.key}
        className="grid w-full grid-cols-3 items-center gap-3 rounded p-2 text-left text-sm hover:bg-ink-wash focus-visible:outline-accent-500">
        <span className="break-words font-medium text-ink">{bar.label}</span>
        <svg className="col-span-2 w-full" height="24" aria-label={`${bar.label}: ${bar.calls} ${bar.calls === 1 ? "call" : "calls"}`}><rect width={`${bar.calls / max * 85}%`} height="20" rx="3" className={bar.key === "__emerging" ? "fill-muted" : "fill-accent-500"} /><text x="98%" y="15" textAnchor="end" className="fill-ink text-xs">{bar.calls.toLocaleString()}</text></svg>
      </button>)}</div>}
    {data.canManage && emergingCalls > 0 && <details className="mt-4"><summary className="cursor-pointer text-sm text-muted">Emerging keys ({emerging.filter(key => key.calls > 0).length})</summary>
      <ul className="mt-2 space-y-1">{emerging.filter(key => key.calls > 0).map(key => <li key={key.key}><Button size="sm" variant="ghost" onClick={() => onSelect(key.key)}>{key.label}: {key.calls}</Button><p className="text-xs text-muted">{key.definition}</p></li>)}</ul>
    </details>}
  </CardBody>
    <div className="overflow-x-auto"><table className="w-full text-sm"><thead className="bg-paper-muted text-xs text-muted"><tr>
      <th className="px-5 py-3 text-left font-medium">Key & definition</th><th className="px-3 py-3 text-right font-medium">Calls</th><th className="px-3 py-3 text-right font-medium">Users</th><th className="px-5 py-3 text-right font-medium">Error rate</th>
    </tr></thead><tbody>{active.filter(key => key.calls > 0 || data.canManage).map(row => <tr key={`${row.key}:${row.label}:${row.definition}`} className="border-t border-line align-top">
      <td className="px-5 py-3"><Button size="sm" variant="ghost" onClick={() => onSelect(row.key)}>{row.label}</Button>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted"><code>{row.key}</code><Badge>{row.status}</Badge><span>{row.origin}</span></div>
        <p className="mt-2 max-w-xl text-xs leading-relaxed text-muted">{row.definition}</p>
        {data.canManage && <KeyEditor row={row} keys={active} />}</td>
      <td className="px-3 py-3 text-right tabular-nums">{row.calls.toLocaleString()}</td><td className="px-3 py-3 text-right tabular-nums">{row.uniqueUsers.toLocaleString()}</td><td className="px-5 py-3 text-right tabular-nums">{(row.errorRate * 100).toFixed(1)}%</td>
    </tr>)}</tbody></table></div>
  </Card>;
}
