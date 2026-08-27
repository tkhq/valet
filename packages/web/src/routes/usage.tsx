/**
 * `/usage` — LLM recording gateway dashboard.
 *
 * Displays per-user/model/harness spend, a daily spend chart, a paginated
 * request log with drill-down, and an onboarding panel for minting a proxy key.
 * Data comes from `GET /api/proxy/usage/summary` and `GET /api/proxy/requests`.
 */
import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useProxyUsageSummary, useProxyRequests } from "~/api/proxy-usage";
import { SpendChart, buildDayBuckets } from "~/components/usage/SpendChart";
import { BreakdownTable, type BreakdownRow } from "~/components/usage/BreakdownTable";
import { RequestLog } from "~/components/usage/RequestLog";
import { SampleView } from "~/components/usage/SampleView";
import { OnboardingPanel } from "~/components/usage/OnboardingPanel";
import type { ProxyUserBucket, ProxyModelBucket, ProxyHarnessBucket } from "@valet/api/wire";

export const Route = createFileRoute("/usage")({
  component: UsagePage,
});

const WINDOWS = ["24h", "7d", "30d"] as const;
type Window = (typeof WINDOWS)[number];

function fmt(n: number) {
  return n.toLocaleString();
}

function fmtUsd(n: number) {
  return `$${n.toFixed(4)}`;
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-line bg-paper p-4">
      <div className="text-xs text-muted uppercase tracking-wide mb-1">{label}</div>
      <div className="text-xl font-semibold text-ink tabular-nums">{value}</div>
    </div>
  );
}

export function UsagePage() {
  const [window, setWindow] = useState<Window>("7d");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [items, setItems] = useState<Parameters<typeof RequestLog>[0]["items"]>([]);

  const summaryQ = useProxyUsageSummary(window);
  const requestsQ = useProxyRequests({ limit: 50, cursor });

  // Accumulate items across page loads.
  const [seenCursors] = useState(() => new Set<string | undefined>());
  if (!seenCursors.has(cursor) && requestsQ.data) {
    seenCursors.add(cursor);
    const newItems = requestsQ.data.items ?? [];
    setItems((prev) => {
      // Deduplicate by id.
      const ids = new Set(prev.map((i) => i.id));
      const fresh = newItems.filter((i) => !ids.has(i.id));
      return [...prev, ...fresh];
    });
  }

  const summary = summaryQ.data;

  // Build breakdown rows.
  const userRows: BreakdownRow[] =
    summary?.byUser.map((b: ProxyUserBucket) => ({
      label: b.userId,
      requests: b.requests,
      tokens: b.totalTokens,
      costUsd: b.costUsd,
    })) ?? [];

  const modelRows: BreakdownRow[] =
    summary?.byModel.map((b: ProxyModelBucket) => ({
      label: b.model ?? "unknown",
      requests: b.requests,
      tokens: b.totalTokens,
      costUsd: b.costUsd,
    })) ?? [];

  const harnessRows: BreakdownRow[] =
    summary?.byHarness.map((b: ProxyHarnessBucket) => ({
      label: b.harness ?? "unknown",
      requests: b.requests,
      tokens: b.totalTokens,
      costUsd: b.costUsd,
    })) ?? [];

  // Build chart buckets from windowMs.
  const chartBuckets = summary
    ? buildDayBuckets(summary.windowMs)
    : [];

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-10 space-y-10">
        {/* Header */}
        <div>
          <h1 className="font-display text-2xl text-ink">Usage</h1>
          <p className="mt-1 text-sm text-muted">
            LLM proxy spend and request log across your org.
          </p>
        </div>

        {/* Window selector */}
        <div className="flex items-center gap-2">
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => {
                setWindow(w);
                setCursor(undefined);
                setItems([]);
                seenCursors.clear();
              }}
              className={`rounded px-3 py-1 text-sm border ${window === w ? "border-moss text-moss bg-moss/10 font-medium" : "border-line text-muted hover:text-ink hover:border-ink"}`}
            >
              {w}
            </button>
          ))}
        </div>

        {/* Totals */}
        {summaryQ.isLoading ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : summaryQ.error ? (
          <p className="text-sm text-danger-600">{String(summaryQ.error)}</p>
        ) : summary ? (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <StatCard label="Total cost" value={fmtUsd(summary.totalCostUsd)} />
              <StatCard label="Requests" value={fmt(summary.totalRequests)} />
              <StatCard label="Input tokens" value={fmt(summary.totalInputTokens)} />
              <StatCard label="Output tokens" value={fmt(summary.totalOutputTokens)} />
            </div>

            {/* Spend chart */}
            <div>
              <h2 className="text-sm font-medium text-ink mb-3">Daily spend</h2>
              <SpendChart buckets={chartBuckets} />
            </div>

            {/* Breakdown tables */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <BreakdownTable title="By user" rows={userRows} />
              <BreakdownTable title="By model" rows={modelRows} />
              <BreakdownTable title="By harness" rows={harnessRows} />
            </div>
          </>
        ) : null}

        {/* Request log + drill-down */}
        <div>
          <h2 className="text-sm font-medium text-ink mb-3">Request log</h2>
          {requestsQ.error && (
            <p className="text-sm text-danger-600 mb-2">{String(requestsQ.error)}</p>
          )}
          <RequestLog
            items={items}
            selectedId={selectedId}
            onSelect={(id) => setSelectedId((prev) => (prev === id ? null : id))}
            nextCursor={requestsQ.data?.nextCursor}
            onLoadMore={() => {
              if (requestsQ.data?.nextCursor) {
                setCursor(requestsQ.data.nextCursor);
              }
            }}
            isLoading={requestsQ.isLoading}
          />
          {selectedId && (
            <div className="mt-4">
              <SampleView id={selectedId} onClose={() => setSelectedId(null)} />
            </div>
          )}
        </div>

        {/* Onboarding */}
        <OnboardingPanel />
      </div>
    </div>
  );
}
