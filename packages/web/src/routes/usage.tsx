/**
 * `/usage` — unified spend dashboard.
 *
 * Shows total spend for the selected window across ALL use cases (engine
 * sessions, orchestrator, workflows, proxy). Primary breakdown is by use
 * case with expandable per-session drill-down for Orchestrator and Sessions.
 * The proxy request log with drill-down (SampleView) stays at the bottom —
 * it is the only place recorded prompts are visible.
 *
 * Data:
 *   GET /api/usage/breakdown  → UsageBreakdownResponse
 *   GET /api/usage/sessions   → UsageSessionsResponse  (lazy on expand)
 *   GET /api/proxy/requests   → paginated request log  (unchanged)
 *   GET /api/proxy/settings   → enabled flag           (unchanged)
 */
import { useState } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useUsageBreakdown, useUsageSessions } from "~/api/usage";
import { useProxyRequests, useProxySettings } from "~/api/proxy-usage";
import { SpendChart } from "~/components/usage/SpendChart";
import { RequestLog } from "~/components/usage/RequestLog";
import { SampleView } from "~/components/usage/SampleView";
import type { UsageUseCase, UsageSessionRow } from "@valet/api/wire";

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

const USE_CASE_LABELS: Record<UsageUseCase, string> = {
  orchestrator: "Orchestrator",
  session: "Sessions",
  workflow: "Workflows",
  proxy: "Proxy (external tools)",
};

/** Nest child sessions under their parents. Returns roots in order, each
 * followed immediately by its children. */
function nestSessions(sessions: UsageSessionRow[]): UsageSessionRow[] {
  const roots: UsageSessionRow[] = [];
  const byParent = new Map<string, UsageSessionRow[]>();

  for (const s of sessions) {
    if (s.isChild && s.parentSessionId) {
      const bucket = byParent.get(s.parentSessionId) ?? [];
      bucket.push(s);
      byParent.set(s.parentSessionId, bucket);
    } else {
      roots.push(s);
    }
  }

  const result: UsageSessionRow[] = [];
  for (const root of roots) {
    result.push(root);
    const children = byParent.get(root.sessionId) ?? [];
    for (const child of children) {
      result.push(child);
    }
  }
  return result;
}

/** Expanded session list for one use case. Calls useUsageSessions lazily. */
function SessionList({
  window,
  useCase,
}: {
  window: string;
  useCase: "orchestrator" | "session";
}) {
  const q = useUsageSessions(window, useCase);

  if (q.isLoading) {
    return <p className="text-xs text-muted px-4 py-2">Loading…</p>;
  }
  if (q.error) {
    return (
      <p className="text-xs text-danger-600 px-4 py-2">{String(q.error)}</p>
    );
  }
  const sessions = nestSessions(q.data?.sessions ?? []);
  if (sessions.length === 0) {
    return <p className="text-xs text-muted px-4 py-2">No sessions in this window.</p>;
  }

  return (
    <div className="border-t border-line divide-y divide-line">
      {sessions.map((s) => {
        const isOrchId = s.sessionId.startsWith("orchestrator:");
        const title = s.title ?? s.sessionId;
        const titleEl = !isOrchId ? (
          <Link
            to="/sessions/$sessionId"
            params={{ sessionId: s.sessionId }}
            className="text-moss hover:underline underline-offset-2 truncate"
          >
            {title}
          </Link>
        ) : (
          <span className="truncate text-muted">{title}</span>
        );

        return (
          <div
            key={s.sessionId}
            className={`flex items-center gap-2 px-4 py-2 text-xs ${s.isChild ? "pl-8 bg-ink-wash/10" : ""}`}
          >
            <div className="flex-1 min-w-0">{titleEl}</div>
            <span className="tabular-nums text-muted shrink-0">
              {fmtUsd(s.costUsd)}
            </span>
            <span className="tabular-nums text-muted shrink-0 w-20 text-right">
              {fmt(s.totalTokens)} tok
            </span>
            <span className="tabular-nums text-muted shrink-0 w-14 text-right">
              {s.turns} turns
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** One expandable use-case row. Only orchestrator and session are expandable. */
function UseCaseRow({
  useCase,
  costUsd,
  totalTokens,
  turns,
  window,
}: {
  useCase: UsageUseCase;
  costUsd: number;
  totalTokens: number;
  turns: number;
  window: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const expandable = useCase === "orchestrator" || useCase === "session";

  return (
    <div className="border-b border-line last:border-0">
      <div
        className={`flex items-center gap-3 px-4 py-3 text-sm ${expandable ? "cursor-pointer hover:bg-ink-wash/20" : ""}`}
        onClick={expandable ? () => setExpanded((v) => !v) : undefined}
        role={expandable ? "button" : undefined}
        tabIndex={expandable ? 0 : undefined}
        onKeyDown={
          expandable
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") setExpanded((v) => !v);
              }
            : undefined
        }
        aria-expanded={expandable ? expanded : undefined}
        aria-label={
          expandable ? `${USE_CASE_LABELS[useCase]} — expand sessions` : undefined
        }
      >
        {expandable && (
          <span
            className={`text-muted transition-transform ${expanded ? "rotate-90" : ""}`}
            aria-hidden
          >
            ›
          </span>
        )}
        {!expandable && <span className="w-3" />}
        <span className="flex-1 text-ink font-medium">{USE_CASE_LABELS[useCase]}</span>
        <span className="tabular-nums text-muted w-24 text-right">{fmtUsd(costUsd)}</span>
        <span className="tabular-nums text-muted w-24 text-right">
          {fmt(totalTokens)} tok
        </span>
        <span className="tabular-nums text-muted w-16 text-right">{turns} turns</span>
      </div>
      {expandable && expanded && (
        <SessionList
          window={window}
          useCase={useCase as "orchestrator" | "session"}
        />
      )}
    </div>
  );
}

export function UsagePage() {
  const [window, setWindow] = useState<Window>("7d");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [items, setItems] = useState<Parameters<typeof RequestLog>[0]["items"]>([]);

  const breakdownQ = useUsageBreakdown(window);
  const requestsQ = useProxyRequests({ limit: 50, cursor });
  const settingsQ = useProxySettings();

  // Accumulate items across page loads.
  const [seenCursors] = useState(() => new Set<string | undefined>());
  if (!seenCursors.has(cursor) && requestsQ.data) {
    seenCursors.add(cursor);
    const newItems = requestsQ.data.items ?? [];
    setItems((prev) => {
      const ids = new Set(prev.map((i) => i.id));
      const fresh = newItems.filter((i) => !ids.has(i.id));
      return [...prev, ...fresh];
    });
  }

  const breakdown = breakdownQ.data;
  const USE_CASE_ORDER: UsageUseCase[] = [
    "orchestrator",
    "session",
    "workflow",
    "proxy",
  ];

  const modelRows = breakdown?.byModel ?? [];
  const chartBuckets = breakdown?.byDay ?? [];

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-10 space-y-10">
        {/* Header */}
        <div>
          <h1 className="font-display text-2xl text-ink">Usage</h1>
          <p className="mt-1 text-sm text-muted">
            Spend across all Valet use cases for your account.
          </p>
        </div>

        {/* Disabled-gateway notice */}
        {settingsQ.data?.enabled === false && (
          <div className="rounded border border-line bg-paper px-4 py-3 text-sm text-muted">
            The recording gateway is disabled — enable it in{" "}
            <Link
              to="/settings/organization/proxy"
              className="text-moss underline-offset-2 hover:underline"
            >
              Settings → Proxy
            </Link>
            .
          </div>
        )}

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
              className={`rounded px-3 py-1 text-sm border ${
                window === w
                  ? "border-moss text-moss bg-moss/10 font-medium"
                  : "border-line text-muted hover:text-ink hover:border-ink"
              }`}
            >
              {w}
            </button>
          ))}
        </div>

        {/* Totals + chart + by-use-case + by-model */}
        {breakdownQ.isLoading ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : breakdownQ.error ? (
          <p className="text-sm text-danger-600">{String(breakdownQ.error)}</p>
        ) : breakdown ? (
          <>
            {/* Total stat cards */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <StatCard label="Total cost" value={fmtUsd(breakdown.totalCostUsd)} />
              <StatCard label="Total tokens" value={fmt(breakdown.totalTokens)} />
              <StatCard label="Input tokens" value={fmt(breakdown.totalInputTokens)} />
              <StatCard label="Output tokens" value={fmt(breakdown.totalOutputTokens)} />
            </div>

            {/* Daily spend chart */}
            <div>
              <h2 className="text-sm font-medium text-ink mb-3">Daily spend</h2>
              <SpendChart buckets={chartBuckets} />
            </div>

            {/* By use case — primary, expandable for orchestrator + sessions */}
            <div>
              <h2 className="text-sm font-medium text-ink mb-3">By use case</h2>
              <div className="rounded border border-line overflow-hidden">
                {/* Header row */}
                <div className="flex items-center gap-3 px-4 py-2 bg-paper-muted border-b border-line text-xs font-medium text-muted">
                  <span className="w-3" />
                  <span className="flex-1">Use case</span>
                  <span className="w-24 text-right">Cost (USD)</span>
                  <span className="w-24 text-right">Tokens</span>
                  <span className="w-16 text-right">Turns</span>
                </div>
                {USE_CASE_ORDER.map((uc) => {
                  const bucket = breakdown.byUseCase.find((b) => b.useCase === uc);
                  if (!bucket) return null;
                  return (
                    <UseCaseRow
                      key={uc}
                      useCase={uc}
                      costUsd={bucket.costUsd}
                      totalTokens={bucket.totalTokens}
                      turns={bucket.turns}
                      window={window}
                    />
                  );
                })}
                {breakdown.byUseCase.length === 0 && (
                  <div className="px-4 py-3 text-sm text-muted">
                    No spend recorded in this window.
                  </div>
                )}
              </div>
            </div>

            {/* By model */}
            <div>
              <h2 className="text-sm font-medium text-ink mb-3">By model</h2>
              {modelRows.length === 0 ? (
                <p className="text-sm text-muted">No data.</p>
              ) : (
                <div className="overflow-x-auto rounded border border-line">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-line bg-paper-muted">
                        <th className="px-3 py-2 text-left font-medium text-muted">
                          Model
                        </th>
                        <th className="px-3 py-2 text-right font-medium text-muted">
                          Turns
                        </th>
                        <th className="px-3 py-2 text-right font-medium text-muted">
                          Tokens
                        </th>
                        <th className="px-3 py-2 text-right font-medium text-muted">
                          Cost (USD)
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {modelRows.map((row) => (
                        <tr
                          key={row.model ?? "unknown"}
                          className="border-b border-line last:border-0 hover:bg-ink-wash/30"
                        >
                          <td
                            className="px-3 py-2 text-ink truncate max-w-[14rem]"
                            title={row.model ?? undefined}
                          >
                            {row.model ?? (
                              <span className="text-muted italic">unknown</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-muted">
                            {row.turns.toLocaleString()}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-muted">
                            {row.totalTokens.toLocaleString()}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-muted">
                            ${row.costUsd.toFixed(4)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        ) : null}

        {/* Proxy (external tools) — request log + drill-down */}
        <div>
          <h2 className="text-sm font-medium text-ink mb-1">
            Proxy (external tools) — request log
          </h2>
          <p className="text-xs text-muted mb-3">
            Recorded prompts from external tools routed through the gateway.
          </p>
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

        {/* Key setup callout */}
        <div className="rounded border border-line bg-paper px-4 py-3 text-sm text-muted">
          Generate a key and set up your tools in{" "}
          <Link
            to="/settings/proxy"
            className="text-moss underline-offset-2 hover:underline"
          >
            Settings → Proxy
          </Link>
          .
        </div>
      </div>
    </div>
  );
}
