import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  FileWarning,
  Hammer,
  MessageSquare,
  Wrench,
  X,
} from "lucide-react";
import type {
  SecurityCellWire,
  SecurityEngagementWire,
  SecurityFindingSeverity,
  SecurityFindingWire,
} from "@valet/api/wire";
import type { SecurityFindingsFilters } from "~/api/security";
import {
  apiErrorText,
  flattenFindings,
  useAddFindingComment,
  useReviewFinding,
  useSecurityFindings,
} from "~/api/security";
import { Markdown } from "~/components/markdown";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  Input,
  SelectMenu,
  Spinner,
  Textarea,
} from "~/components/primitives";
import { ServiceIcon } from "~/components/service-icon";
import { useDebouncedValue } from "~/hooks/use-debounced-value";
import { useComposerPrefillStore } from "~/stores/composer-prefill";
import { cn } from "~/lib/cn";
import { relativeTime } from "~/lib/relative-time";
import { useResizablePane } from "~/lib/use-resizable-pane";
import { ExportDialog } from "./export-dialog";
import { FileIssueDialog, type FileIssueTarget } from "./file-issue-dialog";
import { FindingStatusChip, SeverityBadge, SeverityBar, severityRank } from "./severity";

/**
 * Findings review — the triage surface (valet-security design §Findings
 * review). Master-detail: a filterable, fingerprint-grouped list and a
 * detail pane with evidence, provenance, siblings, and the human actions
 * (verify/refute, file issue, fix handoff, permalink).
 *
 * Evidence bodies are data from an agent that read HOSTILE code (spec
 * threat 8). They render through `~/components/markdown` — react-markdown
 * with no rehype-raw, so embedded HTML is never parsed into elements; it
 * stays escaped text. Never switch this to a renderer that executes HTML.
 *
 * Triage is keyboard-first: j/k move, v verify, r refute (reason dialog),
 * i file issue, Enter opens the blob link. The handler is scoped to the
 * list container's own keydown — it never touches `document`, so typing in
 * the filter inputs (or anywhere else) is unaffected.
 */

type SortKey = "severity" | "recency";

/** GitHub blob URL at the pinned SHA — a finding the user cannot jump to is
 * dead text. Null while the engagement is unstarted (no pinned ref). */
export function blobUrl(
  engagement: Pick<SecurityEngagementWire, "repoFullName" | "repoRef">,
  file: string | null,
  line: number | null,
): string | null {
  if (!file || engagement.repoRef === "") return null;
  const path = file
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return `https://github.com/${engagement.repoFullName}/blob/${engagement.repoRef}/${path}${
    line !== null ? `#L${line}` : ""
  }`;
}

/** One list row: a fingerprint group's representative plus its siblings.
 * Ungrouped findings are a group of one. */
export interface FindingRow {
  finding: SecurityFindingWire;
  siblings: SecurityFindingWire[];
}

/** Pure: sort + group for the list. Groups keep the position of their
 * best-ranked member; the representative is the first in sort order. */
export function groupFindings(findings: SecurityFindingWire[], sort: SortKey): FindingRow[] {
  const sorted = [...findings].sort((a, b) => {
    if (sort === "severity") {
      const bySeverity = severityRank(a.severity) - severityRank(b.severity);
      if (bySeverity !== 0) return bySeverity;
    }
    return b.createdAt - a.createdAt;
  });
  const rows: FindingRow[] = [];
  const byFingerprint = new Map<string, FindingRow>();
  for (const finding of sorted) {
    const existing = byFingerprint.get(finding.fingerprint);
    if (existing) {
      existing.siblings.push(finding);
    } else {
      const row: FindingRow = { finding, siblings: [] };
      byFingerprint.set(finding.fingerprint, row);
      rows.push(row);
    }
  }
  return rows;
}

const SEVERITY_OPTIONS = [
  { value: "", label: "Any severity" },
  { value: "critical", label: "Critical" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
  { value: "info", label: "Info" },
] as const;

const STATUS_OPTIONS = [
  { value: "", label: "Any status" },
  { value: "open", label: "Open" },
  { value: "verified", label: "Verified" },
  { value: "refuted", label: "Refuted" },
] as const;

/** The default reason the Verify action stamps. The route requires a
 * non-empty reason for both statuses; refute prompts, verify does not (the
 * keyboard contract is one keystroke), so verify sends this. */
export const VERIFY_REASON = "Verified from the findings review surface.";

export function FindingsReview({
  sessionId,
  engagement,
  cells,
  canAdminister,
  initialFindingId,
  polling,
  onOpenChild,
}: {
  sessionId: string;
  engagement: SecurityEngagementWire;
  cells: SecurityCellWire[];
  /** Gates Verify/Refute — the route holds `canAdministerSession`; this
   * only hides buttons that would 403. */
  canAdminister: boolean;
  /** Preselect from the `?finding=` permalink param. */
  initialFindingId?: string;
  /** True while the engagement runs — findings refetch on the poll cadence. */
  polling: boolean;
  /** Open a fix session as the in-page `?child=` slide-over. Absent (e.g.
   * standalone rendering) falls back to the child's standalone page. */
  onOpenChild?: (childId: string) => void;
}) {
  const [severity, setSeverity] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const [cellId, setCellId] = useState<string>("");
  const [pathInput, setPathInput] = useState("");
  const path = useDebouncedValue(pathInput, 250);
  const [sort, setSort] = useState<SortKey>("severity");

  const filters: SecurityFindingsFilters = useMemo(
    () => ({
      severity: severity === "" ? undefined : (severity as SecurityFindingsFilters["severity"]),
      status: status === "" ? undefined : (status as SecurityFindingsFilters["status"]),
      cellId: cellId === "" ? undefined : cellId,
      path: path === "" ? undefined : path,
    }),
    [severity, status, cellId, path],
  );
  const filterActive =
    filters.severity !== undefined ||
    filters.status !== undefined ||
    filters.cellId !== undefined ||
    filters.path !== undefined;

  const query = useSecurityFindings(sessionId, filters, polling ? 5_000 : false);
  const findings = useMemo(() => flattenFindings(query.data?.pages), [query.data]);
  const rows = useMemo(() => groupFindings(findings, sort), [findings, sort]);
  const severityCounts = useMemo(() => {
    const counts: Partial<Record<SecurityFindingSeverity, number>> = {};
    for (const f of findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
    return counts;
  }, [findings]);

  // Selection: mount-time state from a prop (the permalink param), so the
  // useState pairs with a prop-synced effect gated by a userTouched ref —
  // the mount-time-state rule. A j/k or click wins over a later URL sync.
  const [selectedId, setSelectedId] = useState<string | null>(initialFindingId ?? null);
  const userTouchedSelection = useRef(false);
  // The list is the sized (left) pane; the detail fills the rest. Side-by-side
  // only at `xl`, so the handle and width are `xl:`-gated below.
  const listPane = useResizablePane({
    storageKey: "valet:sec-findings-list-width",
    cssVar: "--sec-findings-list-w",
    defaultWidth: 300,
    min: 200,
    max: 560,
    side: "left",
    ariaLabel: "Resize findings list",
  });
  useEffect(() => {
    if (userTouchedSelection.current) return;
    if (initialFindingId) setSelectedId(initialFindingId);
  }, [initialFindingId]);
  function select(id: string) {
    userTouchedSelection.current = true;
    setSelectedId(id);
  }

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  function toggleGroup(fingerprint: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(fingerprint)) next.delete(fingerprint);
      else next.add(fingerprint);
      return next;
    });
  }

  // The selectable sequence j/k walks: representatives, with an expanded
  // group's siblings inline after it.
  const visibleFindings = useMemo(() => {
    const out: SecurityFindingWire[] = [];
    for (const row of rows) {
      out.push(row.finding);
      if (expanded.has(row.finding.fingerprint)) out.push(...row.siblings);
    }
    return out;
  }, [rows, expanded]);

  const selected =
    findings.find((f) => f.id === selectedId) ?? visibleFindings[0] ?? null;

  const review = useReviewFinding(sessionId);
  const addComment = useAddFindingComment(sessionId);
  const [actionError, setActionError] = useState<string | null>(null);
  const [refuteTarget, setRefuteTarget] = useState<SecurityFindingWire | null>(null);
  const [issueTarget, setIssueTarget] = useState<FileIssueTarget | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  function verify(finding: SecurityFindingWire) {
    if (!canAdminister) return;
    setActionError(null);
    review.mutate(
      { findingId: finding.id, status: "verified", reason: VERIFY_REASON },
      { onError: (err) => setActionError(apiErrorText(err)) },
    );
  }

  function moveSelection(delta: number) {
    if (visibleFindings.length === 0) return;
    const currentIndex = selected
      ? visibleFindings.findIndex((f) => f.id === selected.id)
      : -1;
    const next =
      visibleFindings[
        Math.min(Math.max(currentIndex + delta, 0), visibleFindings.length - 1)
      ];
    if (next) select(next.id);
  }

  function handleListKeyDown(e: React.KeyboardEvent) {
    // Never intercept typing: the path filter input lives outside this
    // container, but stay defensive for future inner inputs.
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
    switch (e.key) {
      case "j":
        e.preventDefault();
        moveSelection(1);
        break;
      case "k":
        e.preventDefault();
        moveSelection(-1);
        break;
      case "v":
        e.preventDefault();
        if (selected) verify(selected);
        break;
      case "r":
        e.preventDefault();
        if (selected && canAdminister) setRefuteTarget(selected);
        break;
      case "i":
        e.preventDefault();
        if (selected) setIssueTarget({ mode: "single", finding: selected });
        break;
      case "Enter": {
        e.preventDefault();
        const url = selected ? blobUrl(engagement, selected.file, selected.line) : null;
        if (url) window.open(url, "_blank", "noopener,noreferrer");
        break;
      }
      default:
        break;
    }
  }

  const cellById = useMemo(() => new Map(cells.map((c) => [c.id, c])), [cells]);
  const cellOptions = useMemo(
    () => [
      { value: "", label: "Any cell" },
      ...[...cells]
        .sort((a, b) => a.ordinal - b.ordinal)
        .map((c) => ({ value: c.id, label: c.dir })),
    ],
    [cells],
  );

  return (
    <section className="flex flex-1 flex-col min-h-0" aria-label="Findings review">
      {/* Filters + export header */}
      <div className="flex flex-wrap items-center gap-1.5 px-3 py-2 border-b border-line">
        <SelectMenu
          value={severity}
          options={SEVERITY_OPTIONS}
          onChange={setSeverity}
          triggerClassName="h-7 text-xs"
        />
        <SelectMenu
          value={status}
          options={STATUS_OPTIONS}
          onChange={setStatus}
          triggerClassName="h-7 text-xs"
        />
        <SelectMenu
          value={cellId}
          options={cellOptions}
          onChange={setCellId}
          triggerClassName="h-7 text-xs"
        />
        <Input
          value={pathInput}
          onChange={(e) => setPathInput(e.target.value)}
          placeholder="Filter by path"
          aria-label="Filter by path"
          className="h-7 w-36 text-xs"
        />
        <SelectMenu
          value={sort}
          options={[
            { value: "severity", label: "By severity" },
            { value: "recency", label: "By recency" },
          ]}
          onChange={setSort}
          triggerClassName="h-7 text-xs"
        />
        <span className="flex-1" />
        {filterActive && findings.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              setIssueTarget({ mode: "digest", findingIds: findings.map((f) => f.id) })
            }
          >
            <FileWarning className="h-3.5 w-3.5 mr-1" aria-hidden />
            File digest
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={() => setExportOpen(true)}>
          <Download className="h-3.5 w-3.5 mr-1" aria-hidden />
          Export
        </Button>
      </div>

      {findings.length > 0 && (
        <div className="border-b border-line px-3 py-2">
          <SeverityBar counts={severityCounts} />
        </div>
      )}

      {actionError && (
        <div className="px-3 py-1.5 text-xs text-danger-600 bg-danger-wash border-b border-line">
          {actionError}
        </div>
      )}
      {notice && (
        <div className="px-3 py-1.5 text-xs text-muted border-b border-line">{notice}</div>
      )}

      <div className="flex flex-1 flex-col xl:flex-row min-h-0" style={listPane.containerStyle}>
        {/* List */}
        <div
          role="listbox"
          aria-label="Findings"
          tabIndex={0}
          onKeyDown={handleListKeyDown}
          className="xl:w-[var(--sec-findings-list-w)] xl:max-w-[70%] xl:border-r border-b xl:border-b-0 border-line overflow-y-auto max-h-72 xl:max-h-none focus:outline-none focus-visible:ring-1 focus-visible:ring-accent-400"
        >
          {query.isPending ? (
            <div className="px-3 py-4 text-xs text-muted">
              <Spinner /> Loading findings…
            </div>
          ) : query.isError ? (
            <div className="px-3 py-4 text-xs text-danger-600">
              {apiErrorText(query.error)}
            </div>
          ) : rows.length === 0 ? (
            <div className="px-3 py-4 text-xs text-muted">
              {filterActive ? "No findings match the filters." : "No findings reported yet."}
            </div>
          ) : (
            <ul className="divide-y divide-line">
              {rows.map((row) => (
                <FindingListRow
                  key={row.finding.id}
                  row={row}
                  cellDir={cellById.get(row.finding.cellId)?.dir}
                  selectedId={selected?.id ?? null}
                  expanded={expanded.has(row.finding.fingerprint)}
                  onSelect={select}
                  onToggleGroup={toggleGroup}
                />
              ))}
            </ul>
          )}
          {query.hasNextPage && (
            <div className="px-3 py-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                {query.isFetchingNextPage ? "Loading…" : "Load more"}
              </Button>
            </div>
          )}
        </div>

        {/* Resize handle between list and detail, side-by-side layout only. */}
        <div
          {...listPane.handleProps}
          className="hidden xl:block w-1 shrink-0 cursor-col-resize bg-line hover:bg-moss/50 focus:bg-moss focus:outline-none"
        />

        {/* Detail */}
        <div className="flex-1 min-w-0 overflow-y-auto">
          {selected ? (
            <FindingDetail
              finding={selected}
              engagement={engagement}
              cell={cellById.get(selected.cellId)}
              siblings={findings.filter(
                (f) => f.fingerprint === selected.fingerprint && f.id !== selected.id,
              )}
              canAdminister={canAdminister}
              reviewPending={review.isPending}
              commentPending={addComment.isPending}
              onAddComment={(finding, body) => {
                setActionError(null);
                addComment.mutate(
                  { findingId: finding.id, body },
                  { onError: (err) => setActionError(apiErrorText(err)) },
                );
              }}
              onVerify={() => verify(selected)}
              onRefute={() => setRefuteTarget(selected)}
              onFileIssue={() => setIssueTarget({ mode: "single", finding: selected })}
              onFix={() => {
                useComposerPrefillStore
                  .getState()
                  .set(`Spawn a fix session for finding ${selected.id} via sec_handoff`);
                useComposerPrefillStore.getState().requestFocus();
                setNotice("Fix command placed in the chat composer. Send it to the runner.");
              }}
              onSelectSibling={select}
              onNotice={setNotice}
              onOpenChild={onOpenChild}
            />
          ) : (
            <div className="px-4 py-6 text-xs text-muted">Select a finding to review it.</div>
          )}
        </div>
      </div>

      <RefuteDialog
        finding={refuteTarget}
        pending={review.isPending}
        onClose={() => setRefuteTarget(null)}
        onSubmit={(finding, reason) => {
          setActionError(null);
          review.mutate(
            { findingId: finding.id, status: "refuted", reason },
            {
              onSuccess: () => setRefuteTarget(null),
              onError: (err) => setActionError(apiErrorText(err)),
            },
          );
        }}
      />
      <ExportDialog
        sessionId={sessionId}
        open={exportOpen}
        onOpenChange={setExportOpen}
        currentFilters={filters}
        filterActive={filterActive}
      />
      <FileIssueDialog
        sessionId={sessionId}
        engagement={engagement}
        target={issueTarget}
        onClose={() => setIssueTarget(null)}
      />
    </section>
  );
}

function FindingListRow({
  row,
  cellDir,
  selectedId,
  expanded,
  onSelect,
  onToggleGroup,
}: {
  row: FindingRow;
  cellDir: string | undefined;
  selectedId: string | null;
  expanded: boolean;
  onSelect: (id: string) => void;
  onToggleGroup: (fingerprint: string) => void;
}) {
  const grouped = row.siblings.length > 0;
  return (
    <li>
      <FindingRowLine
        finding={row.finding}
        cellDir={cellDir}
        selected={selectedId === row.finding.id}
        onSelect={onSelect}
        leading={
          grouped ? (
            <button
              type="button"
              aria-label={expanded ? "Collapse duplicates" : "Expand duplicates"}
              aria-expanded={expanded}
              onClick={(e) => {
                e.stopPropagation();
                onToggleGroup(row.finding.fingerprint);
              }}
              className="text-muted hover:text-ink shrink-0"
            >
              {expanded ? (
                <ChevronDown className="h-3.5 w-3.5" aria-hidden />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" aria-hidden />
              )}
            </button>
          ) : undefined
        }
        trailing={grouped ? <Badge variant="neutral">×{row.siblings.length + 1}</Badge> : undefined}
      />
      {grouped && expanded && (
        <ul>
          {row.siblings.map((sibling) => (
            <li key={sibling.id} className="pl-5">
              <FindingRowLine
                finding={sibling}
                cellDir={cellDir}
                selected={selectedId === sibling.id}
                onSelect={onSelect}
              />
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function FindingRowLine({
  finding,
  cellDir,
  selected,
  onSelect,
  leading,
  trailing,
}: {
  finding: SecurityFindingWire;
  cellDir: string | undefined;
  selected: boolean;
  onSelect: (id: string) => void;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
}) {
  const links = finding.links ?? [];
  const fixCount = (finding.handoffs ?? []).length;
  const noteCount = (finding.comments ?? []).length;
  return (
    <div
      role="option"
      aria-selected={selected}
      onClick={() => onSelect(finding.id)}
      className={cn(
        "px-3 py-2 cursor-pointer text-xs min-w-0",
        selected ? "bg-moss-wash" : "hover:bg-ink-wash",
      )}
    >
      {/* Line 1: severity + the full title (wraps to two lines instead of
          truncating on one crowded row). */}
      <div className="flex items-start gap-1.5 min-w-0">
        {leading}
        <span className="mt-px shrink-0">
          <SeverityBadge severity={finding.severity} />
        </span>
        {/* Re-scan / iterate: `recurring` is present only on a re-scan's
            findings (undefined on a first review). A new-vs-recurring badge
            tells triage which findings the prior review had not seen. */}
        {finding.recurring !== undefined && (
          <span className="mt-px shrink-0">
            <Badge variant={finding.recurring ? "neutral" : "accent"}>
              {finding.recurring ? "recurring" : "new"}
            </Badge>
          </span>
        )}
        <span className="font-medium text-ink min-w-0 flex-1 line-clamp-2">{finding.title}</span>
        {trailing && <span className="shrink-0">{trailing}</span>}
      </div>
      {/* Line 2: the metadata that used to crowd the title off the row. */}
      <div className="mt-1 flex items-center flex-wrap gap-x-2 gap-y-1 text-[11px] text-muted">
        <FindingStatusChip status={finding.status} />
        {cellDir && <span className="shrink-0">{cellDir}</span>}
        {finding.file && (
          <span className="font-mono truncate max-w-full min-w-0">
            {finding.file}
            {finding.line !== null ? `:${finding.line}` : ""}
          </span>
        )}
        {links.map((link) => (
          <a
            key={link.id}
            href={link.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            aria-label={`Open ${link.provider} issue ${link.externalId}`}
            className="shrink-0"
          >
            <ServiceIcon slug={link.provider} label={link.provider} size="sm" />
          </a>
        ))}
        {fixCount > 0 && (
          <span className="inline-flex items-center shrink-0">
            <Wrench className="h-3 w-3 mr-0.5" aria-hidden />
            {fixCount} fix
          </span>
        )}
        {noteCount > 0 && (
          <span className="inline-flex items-center shrink-0" aria-label={`${noteCount} notes`}>
            <MessageSquare className="h-3 w-3 mr-0.5" aria-hidden />
            {noteCount}
          </span>
        )}
      </div>
    </div>
  );
}

function FindingDetail({
  finding,
  engagement,
  cell,
  siblings,
  canAdminister,
  reviewPending,
  commentPending,
  onAddComment,
  onVerify,
  onRefute,
  onFileIssue,
  onFix,
  onSelectSibling,
  onNotice,
  onOpenChild,
}: {
  finding: SecurityFindingWire;
  engagement: SecurityEngagementWire;
  cell: SecurityCellWire | undefined;
  siblings: SecurityFindingWire[];
  canAdminister: boolean;
  reviewPending: boolean;
  commentPending: boolean;
  /** Post a human note on the finding. Any viewer may — not admin-gated. */
  onAddComment: (finding: SecurityFindingWire, body: string) => void;
  onVerify: () => void;
  onRefute: () => void;
  onFileIssue: () => void;
  onFix: () => void;
  onSelectSibling: (id: string) => void;
  onNotice: (text: string) => void;
  /** Open a fix session as the in-page `?child=` slide-over. */
  onOpenChild?: (childId: string) => void;
}) {
  const url = blobUrl(engagement, finding.file, finding.line);
  return (
    <article className="px-4 py-3 space-y-3 text-xs" aria-label={finding.title}>
      <header className="space-y-1">
        <div className="flex items-center gap-2 flex-wrap">
          <SeverityBadge severity={finding.severity} />
          <FindingStatusChip status={finding.status} />
          <h3 className="text-sm font-semibold text-ink">{finding.title}</h3>
        </div>
        {finding.file && (
          <div className="font-mono">
            {url ? (
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent-600 dark:text-accent-100 hover:underline inline-flex items-center gap-1"
              >
                {finding.file}
                {finding.line !== null ? `:${finding.line}` : ""}
                <ExternalLink className="h-3 w-3" aria-hidden />
              </a>
            ) : (
              <span className="text-muted">
                {finding.file}
                {finding.line !== null ? `:${finding.line}` : ""}
              </span>
            )}
          </div>
        )}
      </header>

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-1.5">
        {canAdminister && (
          <>
            <Button
              size="sm"
              variant="secondary"
              disabled={reviewPending || finding.status === "verified"}
              onClick={onVerify}
            >
              <Check className="h-3.5 w-3.5 mr-1" aria-hidden />
              Verify
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={reviewPending || finding.status === "refuted"}
              onClick={onRefute}
            >
              <X className="h-3.5 w-3.5 mr-1" aria-hidden />
              Refute
            </Button>
          </>
        )}
        <Button size="sm" variant="secondary" onClick={onFileIssue}>
          File issue
        </Button>
        <Button size="sm" variant="secondary" onClick={onFix}>
          <Hammer className="h-3.5 w-3.5 mr-1" aria-hidden />
          Fix
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            const permalink = new URL(window.location.href);
            permalink.searchParams.set("finding", finding.id);
            void navigator.clipboard.writeText(permalink.toString());
            onNotice("Permalink copied.");
          }}
        >
          <Copy className="h-3.5 w-3.5 mr-1" aria-hidden />
          Copy permalink
        </Button>
      </div>

      {/* Evidence — hostile data; escaped markdown only (see module note). */}
      <div className="border border-line rounded-md px-3 py-2">
        <Markdown>{finding.body}</Markdown>
      </div>

      {/* Provenance */}
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5">
        <dt className="text-muted">Cell</dt>
        <dd className="font-mono">
          {cell ? `${cell.dir} (${cell.persona})` : finding.cellId}
        </dd>
        <dt className="text-muted">Reported</dt>
        <dd>{new Date(finding.createdAt).toLocaleString()}</dd>
        <dt className="text-muted">Fingerprint</dt>
        <dd className="font-mono">{finding.fingerprint}</dd>
        {finding.statusActor && (
          <>
            <dt className="text-muted">Reviewed by</dt>
            <dd className="font-mono">{finding.statusActor}</dd>
          </>
        )}
        {finding.statusReason && (
          <>
            <dt className="text-muted">Reason</dt>
            <dd>{finding.statusReason}</dd>
          </>
        )}
      </dl>

      {/* Filed issues */}
      {(finding.links ?? []).length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {(finding.links ?? []).map((link) => (
            <a
              key={link.id}
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-accent-600 dark:text-accent-100 hover:underline"
            >
              <ServiceIcon slug={link.provider} label={link.provider} size="sm" />
              {link.externalId}
            </a>
          ))}
        </div>
      )}

      {/* Fix sessions — the sec_handoff children spawned from this finding.
          Open each as the in-page child slide-over. */}
      {(finding.handoffs ?? []).length > 0 && (
        <div>
          <div className="text-muted mb-1 flex items-center gap-1">
            <Wrench className="h-3 w-3" aria-hidden />
            Fix sessions
          </div>
          <ul className="space-y-1">
            {(finding.handoffs ?? []).map((handoff) => (
              <li
                key={handoff.childSessionId}
                className="flex items-center gap-2 min-w-0"
              >
                <span className="truncate min-w-0 flex-1">{handoff.title}</span>
                {onOpenChild ? (
                  <button
                    type="button"
                    onClick={() => onOpenChild(handoff.childSessionId)}
                    className="inline-flex items-center gap-1 text-accent-600 dark:text-accent-100 hover:underline shrink-0"
                    aria-label={`Open fix session ${handoff.title}`}
                  >
                    <ExternalLink className="h-3 w-3" aria-hidden />
                    Open
                  </button>
                ) : (
                  <Link
                    to="/sessions/$sessionId"
                    params={{ sessionId: handoff.childSessionId }}
                    className="inline-flex items-center gap-1 text-accent-600 dark:text-accent-100 hover:underline shrink-0"
                    aria-label={`Open fix session ${handoff.title}`}
                  >
                    <ExternalLink className="h-3 w-3" aria-hidden />
                    Open
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Fingerprint siblings */}
      {siblings.length > 0 && (
        <div>
          <div className="text-muted mb-1">Same fingerprint</div>
          <ul className="space-y-0.5">
            {siblings.map((sibling) => (
              <li key={sibling.id}>
                <button
                  type="button"
                  onClick={() => onSelectSibling(sibling.id)}
                  className="text-accent-600 dark:text-accent-100 hover:underline text-left"
                >
                  {sibling.title}
                  {sibling.file ? ` — ${sibling.file}` : ""}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Notes — human triage reasoning that carries into a re-scan's
          /prior/findings.md. Any viewer may add one. Bodies are human but
          keep the escape discipline: escaped text, never parsed HTML. */}
      <FindingNotes
        finding={finding}
        pending={commentPending}
        onAddComment={onAddComment}
      />
    </article>
  );
}

/** The finding's note thread plus an "Add a note" input. Any viewer may post
 * (spec §Re-scan / iterate); the count and the thread render inert, escaped
 * text. */
function FindingNotes({
  finding,
  pending,
  onAddComment,
}: {
  finding: SecurityFindingWire;
  pending: boolean;
  onAddComment: (finding: SecurityFindingWire, body: string) => void;
}) {
  const comments = finding.comments ?? [];
  const [draft, setDraft] = useState("");
  // Clear the draft when a different finding opens — a note written for one
  // finding must not pre-fill another's (the mount-time-state rule).
  useEffect(() => {
    setDraft("");
  }, [finding.id]);
  return (
    <div>
      <div className="text-muted mb-1 flex items-center gap-1">
        <MessageSquare className="h-3 w-3" aria-hidden />
        Notes
      </div>
      {comments.length > 0 ? (
        <ul className="space-y-1.5 mb-2">
          {comments.map((comment) => (
            <li key={comment.id} className="border border-line rounded-md px-2.5 py-1.5">
              <div className="flex items-center gap-2 text-[11px] text-muted">
                <span className="font-mono">{comment.authorUserId}</span>
                <span>{relativeTime(comment.createdAt)}</span>
              </div>
              {/* Escaped text: a plain string node never parses HTML. */}
              <div className="mt-0.5 whitespace-pre-wrap break-words">{comment.body}</div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="text-muted mb-2">
          No notes yet. Add one to carry your reasoning into the next scan.
        </div>
      )}
      <div className="flex items-start gap-1.5">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Add a note (carries into a re-scan)…"
          aria-label="Add a note"
          rows={2}
          className="flex-1"
        />
        <Button
          size="sm"
          variant="secondary"
          disabled={draft.trim() === "" || pending}
          onClick={() => {
            onAddComment(finding, draft.trim());
            setDraft("");
          }}
        >
          Add note
        </Button>
      </div>
    </div>
  );
}

/** The refute-reason prompt (`r` and the Refute button). The route requires
 * a reason naming what the evidence missed. */
function RefuteDialog({
  finding,
  pending,
  onClose,
  onSubmit,
}: {
  finding: SecurityFindingWire | null;
  pending: boolean;
  onClose: () => void;
  onSubmit: (finding: SecurityFindingWire, reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  // Clear the draft whenever a different finding opens the dialog — a
  // reason written for one finding must not pre-fill another's.
  useEffect(() => {
    setReason("");
  }, [finding?.id]);
  return (
    <Dialog open={finding !== null} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent
        title="Refute finding"
        description={finding ? finding.title : undefined}
      >
        <div className="space-y-2">
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="What did the evidence miss?"
            aria-label="Refute reason"
            rows={3}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={reason.trim() === "" || pending || finding === null}
            onClick={() => finding && onSubmit(finding, reason.trim())}
          >
            Refute
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
