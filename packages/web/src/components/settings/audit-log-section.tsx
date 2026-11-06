import { useState } from "react";
import type { AdminAuditEventWire } from "@valet/api/wire";
import { Button, Time } from "~/components/primitives";
import { Section } from "~/components/settings/section";
import { useAdminAuditLog } from "~/api/audit-log";

/**
 * Organization · Audit log (docs/specs/2026-11-03-admin-audit-log-design.md).
 * One row per admin configuration change, newest first: when, who, what,
 * and the target. A row expands to show the recorded changes, IP, and user
 * agent. Load more fetches the next keyset page.
 */
export function AuditLogSection() {
  const logQ = useAdminAuditLog();
  const [expanded, setExpanded] = useState<string | null>(null);
  const events = logQ.data?.pages.flatMap((page) => page.events) ?? [];

  return (
    <Section title="Audit log" description="Each change to organization settings, admins, providers, images, credentials, and policies.">
      {logQ.isLoading && <p className="py-4 text-sm text-muted">Loading…</p>}
      {logQ.error && <p className="py-4 text-sm text-danger-500">The audit log did not load. Reload the page to try again.</p>}
      {!logQ.isLoading && !logQ.error && events.length === 0 && (
        <p className="py-4 text-sm text-muted">No admin changes are recorded yet.</p>
      )}

      {events.map((event) => (
        <AuditRow
          key={event.id}
          event={event}
          expanded={expanded === event.id}
          onToggle={() => setExpanded(expanded === event.id ? null : event.id)}
        />
      ))}

      {logQ.hasNextPage && (
        <div className="py-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={logQ.isFetchingNextPage}
            onClick={() => void logQ.fetchNextPage()}
          >
            {logQ.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}
    </Section>
  );
}

function AuditRow({
  event,
  expanded,
  onToggle,
}: {
  event: AdminAuditEventWire;
  expanded: boolean;
  onToggle: () => void;
}) {
  const actor = event.actorEmail ?? event.actorUserId ?? "System";
  const target = event.targetName ?? event.targetId;
  return (
    <div className="py-3">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={`Toggle details for ${event.action}`}
        className="flex min-h-11 w-full min-w-0 flex-wrap items-center gap-2 text-left sm:min-h-0"
      >
        <Time ts={event.createdAt} format="absolute" className="text-xs text-muted" />
        <span className="min-w-0 break-all text-sm text-[--fg]">{actor}</span>
        <span className="min-w-0 break-all text-sm font-medium text-[--fg]">{event.action}</span>
        <span className="min-w-0 break-all text-xs text-muted">
          {event.targetType}
          {target ? `: ${target}` : ""}
        </span>
      </button>
      {expanded && (
        <div className="mt-2 space-y-2 rounded bg-neutral-50 p-3 text-xs dark:bg-neutral-900">
          <div>
            <span className="font-medium text-muted">Changes</span>
            <pre className="mt-1 whitespace-pre-wrap break-words">
              {event.changes ? JSON.stringify(event.changes, null, 2) : "None recorded"}
            </pre>
          </div>
          <p className="break-all">
            <span className="font-medium text-muted">IP </span>
            {event.ip ?? "Unknown"}
          </p>
          <p className="break-all">
            <span className="font-medium text-muted">User agent </span>
            {event.userAgent ?? "Unknown"}
          </p>
        </div>
      )}
    </div>
  );
}
