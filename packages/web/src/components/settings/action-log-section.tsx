import { useState } from "react";
import { Link } from "@tanstack/react-router";
import type { ActionLogEntryWire, ApprovalModeWire } from "@valet/api/wire";
import { Badge, Button, Input } from "~/components/primitives";
import { Section } from "~/components/settings/section";
import { useActionLog, type ActionLogFilterState } from "~/api/policies";

const MODE_BADGE: Record<ApprovalModeWire, "success" | "accent" | "danger"> = {
  allow: "success",
  require_approval: "accent",
  deny: "danger",
};

const RESOLVED_MODES: readonly ApprovalModeWire[] = ["allow", "require_approval", "deny"];
const STATUSES = ["allowed", "denied", "approved", "rejected", "error", "completed"] as const;

/**
 * Organization · Action log (action-policies plan, Task 5). Keyset-paginated
 * read over `/api/org/action-log` — a forward-only Next/Previous pager over
 * a client-side cursor stack (no infinite-scroll accumulation, so filter
 * changes reset cleanly to page one). `resolvedMode` is the policy DECISION;
 * `status` is the execution outcome — both are shown, never conflated (see
 * `ActionLogEntryWire`'s doc comment).
 */
export function ActionLogSection() {
  const [filters, setFilters] = useState<ActionLogFilterState>({});
  const [draftService, setDraftService] = useState("");
  const [draftResolvedMode, setDraftResolvedMode] = useState("");
  const [draftStatus, setDraftStatus] = useState("");
  const [cursorHistory, setCursorHistory] = useState<Array<string | undefined>>([undefined]);
  const [expanded, setExpanded] = useState<string | null>(null);

  const cursor = cursorHistory[cursorHistory.length - 1];
  const logQ = useActionLog(filters, cursor);
  const entries = logQ.data?.entries ?? [];

  function applyFilters() {
    const next: ActionLogFilterState = {};
    if (draftService.trim()) next.service = draftService.trim();
    if (draftResolvedMode) next.resolvedMode = draftResolvedMode;
    if (draftStatus) next.status = draftStatus;
    setFilters(next);
    setCursorHistory([undefined]);
  }

  function nextPage() {
    if (logQ.data?.nextCursor) {
      setCursorHistory([...cursorHistory, logQ.data.nextCursor]);
    }
  }

  function prevPage() {
    if (cursorHistory.length > 1) {
      setCursorHistory(cursorHistory.slice(0, -1));
    }
  }

  return (
    <Section title="Action log" description="Every action invocation, with the policy decision that gated it.">
      <div className="flex flex-wrap items-end gap-3 py-4">
        <div>
          <label className="block text-xs font-medium text-muted" htmlFor="log-filter-service">
            Service
          </label>
          <Input
            id="log-filter-service"
            value={draftService}
            onChange={(e) => setDraftService(e.target.value)}
            className="mt-1 w-40"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-muted" htmlFor="log-filter-mode">
            Resolved mode
          </label>
          <select
            id="log-filter-mode"
            value={draftResolvedMode}
            onChange={(e) => setDraftResolvedMode(e.target.value)}
            className="mt-1 h-9 rounded border border-[--border] bg-[--bg] px-2 text-sm"
          >
            <option value="">Any</option>
            {RESOLVED_MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-muted" htmlFor="log-filter-status">
            Status
          </label>
          <select
            id="log-filter-status"
            value={draftStatus}
            onChange={(e) => setDraftStatus(e.target.value)}
            className="mt-1 h-9 rounded border border-[--border] bg-[--bg] px-2 text-sm"
          >
            <option value="">Any</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <Button type="button" variant="secondary" onClick={applyFilters}>
          Apply filters
        </Button>
      </div>

      {logQ.isLoading && <p className="py-4 text-sm text-muted">Loading…</p>}
      {logQ.error && <p className="py-4 text-sm text-danger-500">Failed to load the action log.</p>}
      {!logQ.isLoading && entries.length === 0 && (
        <p className="py-4 text-sm text-muted">No invocations match these filters.</p>
      )}

      {entries.map((entry) => (
        <LogRow
          key={entry.invocationId}
          entry={entry}
          expanded={expanded === entry.invocationId}
          onToggle={() =>
            setExpanded(expanded === entry.invocationId ? null : entry.invocationId)
          }
        />
      ))}

      <div className="flex items-center justify-between py-3">
        <Button type="button" variant="ghost" size="sm" disabled={cursorHistory.length <= 1} onClick={prevPage}>
          Previous
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!logQ.data?.nextCursor}
          onClick={nextPage}
        >
          Next
        </Button>
      </div>
    </Section>
  );
}

function LogRow({
  entry,
  expanded,
  onToggle,
}: {
  entry: ActionLogEntryWire;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="py-3">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={`Toggle details for ${entry.invocationId}`}
        className="flex w-full flex-wrap items-center gap-2 text-left"
      >
        <span className="text-xs text-muted">{new Date(entry.createdAt).toLocaleString()}</span>
        <span className="text-sm font-medium text-[--fg]">
          {entry.service ?? "—"}
          {entry.actionId ? ` / ${entry.actionId}` : ""}
        </span>
        {entry.riskLevel && <Badge variant="neutral">{entry.riskLevel}</Badge>}
        {entry.resolvedMode && (
          <Badge variant={MODE_BADGE[entry.resolvedMode]}>{entry.resolvedMode}</Badge>
        )}
        {entry.status && <span className="text-xs text-muted">status: {entry.status}</span>}
        {entry.sessionId && (
          <Link
            to="/sessions/$sessionId"
            params={{ sessionId: entry.sessionId }}
            onClick={(e) => e.stopPropagation()}
            className="text-xs text-accent-600 underline"
          >
            session
          </Link>
        )}
        {entry.workflowExecutionId && (
          <Link
            to="/workflows/runs/$runId"
            params={{ runId: entry.workflowExecutionId }}
            onClick={(e) => e.stopPropagation()}
            className="text-xs text-accent-600 underline"
          >
            workflow run
          </Link>
        )}
      </button>
      {expanded && (
        <div className="mt-2 space-y-2 rounded bg-neutral-50 p-3 text-xs dark:bg-neutral-900">
          <div>
            <span className="font-medium text-muted">Params</span>
            <pre className="mt-1 whitespace-pre-wrap break-words">
              {JSON.stringify(entry.params, null, 2)}
              {entry.paramsTruncated ? "\n…truncated" : ""}
            </pre>
          </div>
          <div>
            <span className="font-medium text-muted">Result</span>
            <pre className="mt-1 whitespace-pre-wrap break-words">
              {JSON.stringify(entry.result, null, 2)}
              {entry.resultTruncated ? "\n…truncated" : ""}
            </pre>
          </div>
          {entry.error && (
            <div>
              <span className="font-medium text-muted">Error</span>
              <p className="mt-1 whitespace-pre-wrap break-words">{entry.error}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
