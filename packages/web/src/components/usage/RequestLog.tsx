/**
 * Bounded, cursor-paginated proxy request log. It shows metadata only: prompt
 * and response bodies can contain secrets, so the usage page never fetches or
 * renders them.
 */
import type { ProxyRequestListItem } from "@valet/api/wire";
import { Button } from "~/components/primitives";
import { formatRequestDateTime } from "~/lib/format-when";

interface RequestLogProps {
  items: ProxyRequestListItem[];
  pageNumber: number;
  pageSize: number;
  hasPreviousPage: boolean;
  hasNextPage: boolean;
  onPreviousPage: () => void;
  onNextPage: () => void;
  isLoading?: boolean;
}

function statusBadge(code: number, hasError: boolean) {
  if (hasError) return <span className="inline-block rounded px-1.5 py-0.5 text-xs bg-danger-100 text-danger-700">error</span>;
  if (code >= 200 && code < 300) return <span className="inline-block rounded px-1.5 py-0.5 text-xs bg-green-100 text-green-700">{code}</span>;
  return <span className="inline-block rounded px-1.5 py-0.5 text-xs bg-amber-100 text-amber-700">{code}</span>;
}

export function RequestLog({
  items,
  pageNumber,
  pageSize,
  hasPreviousPage,
  hasNextPage,
  onPreviousPage,
  onNextPage,
  isLoading,
}: RequestLogProps) {
  if (items.length === 0 && !isLoading && pageNumber === 1) {
    return <p className="text-sm text-muted">No requests recorded.</p>;
  }

  return (
    <div>
      <div className="max-w-full overflow-x-auto rounded border border-line">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line bg-paper-muted">
              <th className="px-3 py-2 text-left font-medium text-muted whitespace-nowrap">Date / time</th>
              <th className="px-3 py-2 text-left font-medium text-muted">Model</th>
              <th className="px-3 py-2 text-left font-medium text-muted">Harness</th>
              <th className="px-3 py-2 text-right font-medium text-muted">Tokens</th>
              <th className="px-3 py-2 text-right font-medium text-muted">Cost</th>
              <th className="px-3 py-2 text-left font-medium text-muted">Status</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && !isLoading && (
              <tr>
                <td colSpan={6} className="px-3 py-3 text-center text-muted">No requests recorded on this page.</td>
              </tr>
            )}
            {items.map((item) => {
              const date = new Date(item.createdAt);
              const validDate = !Number.isNaN(date.getTime());
              return (
                <tr key={item.id} className="h-11 border-b border-line last:border-0 sm:h-auto hover:bg-ink-wash">
                  <td className="px-3 py-2 text-muted whitespace-nowrap" title={validDate ? date.toISOString() : undefined}>
                    {formatRequestDateTime(item.createdAt)}
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
                  <td className="px-3 py-2">{statusBadge(item.statusCode, item.hasError)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex items-center justify-center gap-3">
        <Button size="sm" variant="secondary" onClick={onPreviousPage} disabled={!hasPreviousPage || isLoading}>
          Previous
        </Button>
        <span className="text-xs text-muted">Page {pageNumber} · {pageSize} requests per page</span>
        <Button size="sm" variant="secondary" onClick={onNextPage} disabled={!hasNextPage || isLoading}>
          Next
        </Button>
      </div>
    </div>
  );
}
