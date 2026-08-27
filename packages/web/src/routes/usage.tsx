/**
 * `/usage` — unified spend dashboard.
 *
 * Shows total spend for the selected window across ALL use cases (engine
 * sessions, orchestrator, workflows, proxy). Token-type breakdown (input /
 * output / cache-read / cache-write) and cache-hit-rate stat visible in the
 * header and By-model table. Org admins can switch to org scope; the byUser
 * table appears in org scope. A team workspace (nav switcher) pins the scope
 * to that team and hides the personal-only surfaces (me/org toggle, proxy
 * request log, key setup). All four use-case rows are expandable via
 * /api/usage/items (symmetric drill-down). CSV export button respects the
 * current window and scope.
 *
 * Data:
 *   GET /api/usage/breakdown?window=&scope=  → UsageBreakdownResponse
 *   GET /api/usage/items?window=&scope=&useCase=  → UsageDrillResponse (lazy on expand)
 *   GET /api/usage/export.csv?window=&scope=      → CSV download
 *   GET /api/proxy/requests   → paginated request log  (unchanged)
 *   GET /api/proxy/settings   → enabled flag           (unchanged)
 */
import { useEffect, useState } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useUsageBreakdown, useUsageItems } from "~/api/usage";
import { useProxyRequests, useProxySettings } from "~/api/proxy-usage";
import { useOrg } from "~/api/settings";
import { SpendChart } from "~/components/usage/SpendChart";
import { RequestLog } from "~/components/usage/RequestLog";
import { SampleView } from "~/components/usage/SampleView";
import { WorkspaceClause } from "~/components/workspace-clause";
import { useWorkspaceScope } from "~/lib/workspace-scope";
import type { UsageUseCase, UsageDrillItem, UsageScopeName } from "@valet/api/wire";
import { api } from "~/api/client";

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

function fmtPct(n: number) {
  return `${(n * 100).toFixed(1)}%`;
}

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded border border-line bg-paper p-4">
      <div className="text-xs text-muted uppercase tracking-wide mb-1">{label}</div>
      <div className="text-xl font-semibold text-ink tabular-nums">{value}</div>
      {sub && <div className="text-xs text-muted mt-1">{sub}</div>}
    </div>
  );
}

const USE_CASE_LABELS: Record<UsageUseCase, string> = {
  orchestrator: "Orchestrator",
  session: "Sessions",
  workflow: "Workflows",
  proxy: "Proxy (external tools)",
};

/** Nest drill items by parentId — roots in order, each followed by children. */
function nestItems(items: UsageDrillItem[]): UsageDrillItem[] {
  const roots: UsageDrillItem[] = [];
  const byParent = new Map<string, UsageDrillItem[]>();

  for (const item of items) {
    if (item.isChild && item.parentId) {
      const bucket = byParent.get(item.parentId) ?? [];
      bucket.push(item);
      byParent.set(item.parentId, bucket);
    } else {
      roots.push(item);
    }
  }

  const result: UsageDrillItem[] = [];
  for (const root of roots) {
    result.push(root);
    for (const child of byParent.get(root.id) ?? []) {
      result.push(child);
    }
  }
  return result;
}

/** Lazy-loaded item list for one use case. */
function ItemList({
  window,
  scope,
  teamId,
  useCase,
}: {
  window: string;
  scope: UsageScopeName;
  teamId: string | undefined;
  useCase: UsageUseCase;
}) {
  const q = useUsageItems(window, scope, useCase, teamId);

  if (q.isLoading) {
    return <p className="text-xs text-muted px-4 py-2">Loading…</p>;
  }
  if (q.error) {
    return (
      <p className="text-xs text-danger-600 px-4 py-2">{String(q.error)}</p>
    );
  }
  const items = nestItems(q.data?.items ?? []);
  if (items.length === 0) {
    return <p className="text-xs text-muted px-4 py-2">No data in this window.</p>;
  }

  return (
    <div className="border-t border-line divide-y divide-line">
      {items.map((item) => {
        const isOrchId = item.sessionId?.startsWith("orchestrator:") ?? false;
        const canLink = item.sessionId !== null && !isOrchId;
        const labelEl = canLink ? (
          <Link
            to="/sessions/$sessionId"
            params={{ sessionId: item.sessionId! }}
            className="text-moss hover:underline underline-offset-2 truncate"
          >
            {item.label}
          </Link>
        ) : (
          <span className="truncate text-muted">{item.label}</span>
        );

        return (
          <div
            key={item.id}
            className={`flex items-center gap-2 px-4 py-2 text-xs ${
              item.isChild ? "pl-8 bg-ink-wash/10" : ""
            }`}
          >
            <div className="flex-1 min-w-0">{labelEl}</div>
            <span className="tabular-nums text-muted shrink-0">
              {fmtUsd(item.costUsd)}
            </span>
            <span className="tabular-nums text-muted shrink-0 w-20 text-right">
              {fmt(item.totalTokens)} tok
            </span>
            <span className="tabular-nums text-muted shrink-0 w-14 text-right">
              {item.turns} turns
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** One expandable use-case row — all four use cases are now expandable. */
function UseCaseRow({
  useCase,
  costUsd,
  totalTokens,
  turns,
  window,
  scope,
  teamId,
}: {
  useCase: UsageUseCase;
  costUsd: number;
  totalTokens: number;
  turns: number;
  window: string;
  scope: UsageScopeName;
  teamId: string | undefined;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border-b border-line last:border-0">
      <div
        className="flex items-center gap-3 px-4 py-3 text-sm cursor-pointer hover:bg-ink-wash/20"
        onClick={() => setExpanded((v) => !v)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") setExpanded((v) => !v);
        }}
        aria-expanded={expanded}
        aria-label={`${USE_CASE_LABELS[useCase]} — expand items`}
      >
        <span
          className={`text-muted transition-transform ${expanded ? "rotate-90" : ""}`}
          aria-hidden
        >
          ›
        </span>
        <span className="flex-1 text-ink font-medium">{USE_CASE_LABELS[useCase]}</span>
        <span className="tabular-nums text-muted w-24 text-right">{fmtUsd(costUsd)}</span>
        <span className="tabular-nums text-muted w-24 text-right">
          {fmt(totalTokens)} tok
        </span>
        <span className="tabular-nums text-muted w-16 text-right">{turns} turns</span>
      </div>
      {expanded && (
        <ItemList window={window} scope={scope} teamId={teamId} useCase={useCase} />
      )}
    </div>
  );
}

export function UsagePage() {
  const [window, setWindow] = useState<Window>("7d");
  const [personalScope, setPersonalScope] = useState<"me" | "org">("me");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [items, setItems] = useState<Parameters<typeof RequestLog>[0]["items"]>([]);

  const orgQ = useOrg();
  const isOrgAdmin =
    orgQ.data?.features.organizations === true &&
    orgQ.data?.callerRole === "admin";

  // A team workspace pins the scope to that team; the me/org toggle only
  // exists in the personal workspace. The toggle's state survives a visit to
  // a team workspace, so switching back restores the view you had.
  const teamId = useWorkspaceScope().teamId;
  const scope: UsageScopeName = teamId !== undefined ? "team" : personalScope;

  const breakdownQ = useUsageBreakdown(window, scope, teamId);
  const requestsQ = useProxyRequests({ limit: 50, cursor });
  const settingsQ = useProxySettings();

  // Accumulate proxy request items across page loads.
  const [seenCursors] = useState(() => new Set<string | undefined>());

  // A workspace switch hides and reshapes the page; drop the proxy log's
  // accumulated pages and any open detail so a return to the personal
  // workspace starts from page one, not a mid-list cursor.
  useEffect(() => {
    setCursor(undefined);
    setItems([]);
    seenCursors.clear();
    setSelectedId(null);
  }, [teamId, seenCursors]);

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
  const byUserRows = breakdown?.byUser ?? [];
  const chartBuckets = breakdown?.byDay ?? [];

  // Cache-hit-rate = cacheReadTokens / (inputTokens + cacheReadTokens)
  const cacheHitRate: number | null =
    breakdown && breakdown.totalInputTokens + breakdown.totalCacheReadTokens > 0
      ? breakdown.totalCacheReadTokens /
        (breakdown.totalInputTokens + breakdown.totalCacheReadTokens)
      : null;

  const csvHref = api.usageExportCsvUrl(window, scope, teamId);

  function handleWindowChange(w: Window) {
    setWindow(w);
    setCursor(undefined);
    setItems([]);
    seenCursors.clear();
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-10 space-y-10">
        {/* Header — the workspace clause names the active scope, same as the
            other scoped list pages. */}
        <div>
          <h1 className="font-display text-2xl text-ink flex items-baseline gap-3">
            Usage
            <WorkspaceClause />
          </h1>
          <p className="mt-1 text-sm text-muted">
            {scope === "team"
              ? "Spend across all Valet use cases for this team."
              : "Spend across all Valet use cases for your account."}
          </p>
        </div>

        {/* Disabled-gateway notice */}
        {scope !== "team" && settingsQ.data?.enabled === false && (
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

        {/* Window selector + scope toggle + CSV export */}
        <div className="flex items-center gap-2 flex-wrap">
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => handleWindowChange(w)}
              className={`rounded px-3 py-1 text-sm border ${
                window === w
                  ? "border-moss text-moss bg-moss/10 font-medium"
                  : "border-line text-muted hover:text-ink hover:border-ink"
              }`}
            >
              {w}
            </button>
          ))}
          {teamId === undefined && isOrgAdmin && (
            <div className="flex items-center gap-1 ml-4 rounded border border-line overflow-hidden text-sm">
              <button
                type="button"
                onClick={() => setPersonalScope("me")}
                className={`px-3 py-1 ${
                  scope === "me"
                    ? "bg-moss/10 text-moss font-medium"
                    : "text-muted hover:text-ink"
                }`}
                aria-pressed={scope === "me"}
              >
                My usage
              </button>
              <button
                type="button"
                onClick={() => setPersonalScope("org")}
                className={`px-3 py-1 ${
                  scope === "org"
                    ? "bg-moss/10 text-moss font-medium"
                    : "text-muted hover:text-ink"
                }`}
                aria-pressed={scope === "org"}
              >
                Organization
              </button>
            </div>
          )}
          <a
            href={csvHref}
            download
            className="ml-auto rounded px-3 py-1 text-sm border border-line text-muted hover:text-ink hover:border-ink"
            aria-label={`Download CSV (${window}, ${scope})`}
          >
            Download CSV ({window}, {scope})
          </a>
        </div>

        {/* Totals + chart + by-use-case + by-model */}
        {breakdownQ.isLoading ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : breakdownQ.error ? (
          <p className="text-sm text-danger-600">{String(breakdownQ.error)}</p>
        ) : breakdown ? (
          <>
            {/* Total stat cards — cost + token types + cache-hit-rate + unpriced */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <StatCard label="Total cost" value={fmtUsd(breakdown.totalCostUsd)} />
              <StatCard label="Total tokens" value={fmt(breakdown.totalTokens)} />
              <StatCard
                label="Input / Output"
                value={`${fmt(breakdown.totalInputTokens)} / ${fmt(breakdown.totalOutputTokens)}`}
              />
              <StatCard
                label="Cache hit rate"
                value={cacheHitRate !== null ? fmtPct(cacheHitRate) : "—"}
                sub={
                  cacheHitRate !== null
                    ? `${fmt(breakdown.totalCacheReadTokens)} read / ${fmt(breakdown.totalCacheWriteTokens)} write`
                    : undefined
                }
              />
            </div>

            {/* Unpriced indicator */}
            {breakdown.unpricedTurns > 0 && (
              <div className="rounded border border-line bg-paper px-4 py-2 text-sm text-muted">
                <span className="font-medium text-ink">{fmt(breakdown.unpricedTurns)} turns unpriced</span>
                {" "}— these turns used custom or dev models with no list price. The cost shown is a floor, not a total.
              </div>
            )}

            {/* Daily spend chart */}
            <div>
              <h2 className="text-sm font-medium text-ink mb-3">Daily spend</h2>
              <SpendChart buckets={chartBuckets} />
            </div>

            {/* By use case — all four rows expandable. Keyed by the scope so
                a workspace switch remounts the rows: an expanded drill list
                must not carry over into a different workspace's view. */}
            <div>
              <h2 className="text-sm font-medium text-ink mb-3">By use case</h2>
              <div
                key={`${scope}:${teamId ?? ""}`}
                className="rounded border border-line overflow-hidden"
              >
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
                      scope={scope}
                      teamId={teamId}
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

            {/* By model — with input/output/cache columns */}
            <div>
              <h2 className="text-sm font-medium text-ink mb-3">By model</h2>
              {modelRows.length === 0 ? (
                <p className="text-sm text-muted">No data.</p>
              ) : (
                <div className="overflow-x-auto rounded border border-line">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-line bg-paper-muted">
                        <th className="px-3 py-2 text-left font-medium text-muted">Model</th>
                        <th className="px-3 py-2 text-right font-medium text-muted">Turns</th>
                        <th className="px-3 py-2 text-right font-medium text-muted">Input tok</th>
                        <th className="px-3 py-2 text-right font-medium text-muted">Output tok</th>
                        <th className="px-3 py-2 text-right font-medium text-muted">Cache read</th>
                        <th className="px-3 py-2 text-right font-medium text-muted">Cache write</th>
                        <th className="px-3 py-2 text-right font-medium text-muted">Cost (USD)</th>
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
                            {row.inputTokens.toLocaleString()}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-muted">
                            {row.outputTokens.toLocaleString()}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-muted">
                            {row.cacheReadTokens.toLocaleString()}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-muted">
                            {row.cacheWriteTokens.toLocaleString()}
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

            {/* By member — org scope only, when byUser present */}
            {scope === "org" && byUserRows.length > 0 && (
              <div>
                <h2 className="text-sm font-medium text-ink mb-3">By member</h2>
                <div className="overflow-x-auto rounded border border-line">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-line bg-paper-muted">
                        <th className="px-3 py-2 text-left font-medium text-muted">Member</th>
                        <th className="px-3 py-2 text-right font-medium text-muted">Turns</th>
                        <th className="px-3 py-2 text-right font-medium text-muted">Tokens</th>
                        <th className="px-3 py-2 text-right font-medium text-muted">Cost (USD)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {byUserRows.map((row) => (
                        <tr
                          key={row.userId}
                          className="border-b border-line last:border-0 hover:bg-ink-wash/30"
                        >
                          <td className="px-3 py-2 text-ink truncate max-w-[14rem]" title={row.name}>
                            {row.name || <span className="text-muted italic">unknown</span>}
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
              </div>
            )}
          </>
        ) : null}

        {/* Proxy (external tools) — request log + drill-down. Proxy traffic is
            always personal (never team-owned), so the log and the key-setup
            callout stay out of a team workspace's view. */}
        {scope !== "team" && (
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
        )}

        {/* Key setup callout */}
        {scope !== "team" && (
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
        )}
      </div>
    </div>
  );
}
