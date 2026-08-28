/**
 * Generic breakdown table: one title, rows with label + requests + tokens +
 * cost. Used three times on the dashboard (by user, by model, by harness).
 */

export interface BreakdownRow {
  label: string;
  requests: number;
  tokens: number;
  costUsd: number;
}

interface BreakdownTableProps {
  title: string;
  rows: BreakdownRow[];
}

export function BreakdownTable({ title, rows }: BreakdownTableProps) {
  return (
    <div>
      <h3 className="text-sm font-medium text-ink mb-2">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-muted">No data.</p>
      ) : (
        <div className="overflow-x-auto rounded border border-line">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-paper-muted">
                <th className="px-3 py-2 text-left font-medium text-muted">{title.replace(/^By /, "")}</th>
                <th className="px-3 py-2 text-right font-medium text-muted">Requests</th>
                <th className="px-3 py-2 text-right font-medium text-muted">Tokens</th>
                <th className="px-3 py-2 text-right font-medium text-muted">Cost (USD)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.label} className="border-b border-line last:border-0 hover:bg-ink-wash/30">
                  <td className="px-3 py-2 text-ink truncate max-w-[14rem]" title={row.label}>
                    {row.label || <span className="text-muted italic">unknown</span>}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted">{row.requests.toLocaleString()}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted">{row.tokens.toLocaleString()}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted">${row.costUsd.toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
