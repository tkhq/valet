/**
 * Paginated request log. Displays time, user, model, harness, tokens, cost,
 * and status. Row onClick selects an id for the SampleView drill-down.
 */
import type { ProxyRequestListItem } from "@valet/api/wire";

interface RequestLogProps {
  items: ProxyRequestListItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  nextCursor?: string;
  onLoadMore?: () => void;
  isLoading?: boolean;
}

function statusBadge(code: number, error: string | null) {
  if (error) return <span className="inline-block rounded px-1.5 py-0.5 text-xs bg-danger-100 text-danger-700">error</span>;
  if (code >= 200 && code < 300) return <span className="inline-block rounded px-1.5 py-0.5 text-xs bg-green-100 text-green-700">{code}</span>;
  return <span className="inline-block rounded px-1.5 py-0.5 text-xs bg-amber-100 text-amber-700">{code}</span>;
}

export function RequestLog({ items, selectedId, onSelect, nextCursor, onLoadMore, isLoading }: RequestLogProps) {
  if (items.length === 0 && !isLoading) {
    return <p className="text-sm text-muted">No requests recorded for this window.</p>;
  }

  return (
    <div>
      <div className="overflow-x-auto rounded border border-line">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line bg-paper-muted">
              <th className="px-3 py-2 text-left font-medium text-muted whitespace-nowrap">Time</th>
              <th className="px-3 py-2 text-left font-medium text-muted">User</th>
              <th className="px-3 py-2 text-left font-medium text-muted">Model</th>
              <th className="px-3 py-2 text-left font-medium text-muted">Harness</th>
              <th className="px-3 py-2 text-right font-medium text-muted">Tokens</th>
              <th className="px-3 py-2 text-right font-medium text-muted">Cost</th>
              <th className="px-3 py-2 text-left font-medium text-muted">Status</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const isSelected = item.id === selectedId;
              return (
                <tr
                  key={item.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelect(item.id)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onSelect(item.id); }}
                  aria-pressed={isSelected}
                  className={`border-b border-line last:border-0 cursor-pointer ${isSelected ? "bg-moss/10" : "hover:bg-ink-wash/30"}`}
                >
                  <td className="px-3 py-2 text-muted whitespace-nowrap">
                    {new Date(item.createdAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                  </td>
                  <td className="px-3 py-2 text-muted truncate max-w-[8rem]" title={item.userId}>
                    {item.userId.slice(0, 8)}
                  </td>
                  <td className="px-3 py-2 text-muted truncate max-w-[12rem]" title={item.model ?? undefined}>
                    {item.model ?? <span className="italic">—</span>}
                  </td>
                  <td className="px-3 py-2 text-muted truncate max-w-[8rem]" title={item.harness ?? undefined}>
                    {item.harness ?? <span className="italic">—</span>}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted">{item.totalTokens.toLocaleString()}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted">
                    {item.costUsd != null ? `$${item.costUsd.toFixed(4)}` : "—"}
                  </td>
                  <td className="px-3 py-2">{statusBadge(item.statusCode, item.error)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {nextCursor && onLoadMore && (
        <div className="mt-3 text-center">
          <button
            type="button"
            onClick={onLoadMore}
            disabled={isLoading}
            className="rounded px-3 py-1.5 text-sm border border-line text-muted hover:text-ink hover:border-ink disabled:opacity-50"
          >
            {isLoading ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}
