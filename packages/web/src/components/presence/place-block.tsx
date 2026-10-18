/**
 * A place block on the overview (docs/specs/2026-10-16-presence-hub-design.md
 * Part B steps 4 and 5): a header row with the place's name as a link to its
 * page, the active mark, and the time of the last activity; one sentence row
 * per line of presence; and a quiet `+ Listen for…` that opens the wizard
 * fixed on the place. The block names the place, so a row's sentence leaves
 * out its `<in|on> <place>` clause.
 */
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import type { EventSubscriptionWire } from "@valet/api/wire";
import { AutomationWizard } from "~/components/events/automation-wizard";
import { Button, WorkList } from "~/components/primitives";
import { relativeTime } from "~/lib/relative-time";
import type { PlaceBlockData } from "./overview-groups";
import { PresenceLine } from "./presence-line";
import { usePresenceSentence } from "./presence-rows";
import { SERVICE_NAMES } from "./places";

/** The filter fields that name a place in a sentence. */
const PLACE_FIELDS = new Set(["channel", "repo", "team", "identifier"]);

/**
 * True when a row keeps its place clause. A place block names its place,
 * so its rows drop the clause. A service block names no place, so a line
 * there that names places (`in #a or #b`) keeps them.
 */
export function keepsPlaceClause(block: Pick<PlaceBlockData, "serviceWide">, line: Pick<EventSubscriptionWire, "filters">): boolean {
  return block.serviceWide && line.filters.some((filter) => PLACE_FIELDS.has(filter.field) && (filter.op === "eq" || filter.op === "in"));
}

/** The service block for Slack with no Slack row has no page to open. */
function hasPage(block: PlaceBlockData): boolean {
  return block.subject !== "slack:*";
}

export function PlaceBlock({ block }: { block: PlaceBlockData }) {
  const [adding, setAdding] = useState(false);
  const sentence = usePresenceSentence(block.lines);
  const wizardLabel = block.serviceWide ? SERVICE_NAMES[block.service] : block.label;
  return (
    <section aria-label={block.label}>
      <WorkList>
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3 sm:pl-5 sm:pr-3">
          {hasPage(block)
            ? (
              <Link
                to="/presence/places/$subject"
                params={{ subject: block.subject }}
                className="min-w-0 break-words font-medium text-ink hover:underline"
              >
                {block.label}
              </Link>
            )
            : <span className="min-w-0 break-words font-medium text-ink">{block.label}</span>}
          {block.activeThreadCount > 0 && (
            <span className="inline-flex items-center gap-1.5 text-xs text-muted">
              <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
              {block.activeThreadCount} active
            </span>
          )}
          {block.lastActivityAt !== null && (
            <span className="text-xs tabular-nums text-muted">{relativeTime(block.lastActivityAt)}</span>
          )}
        </div>
        {block.lines.map((line) => (
          <PresenceLine key={line.id} sub={line} sentence={sentence(line, { place: keepsPlaceClause(block, line) })} />
        ))}
        <div className="px-2 py-1.5 sm:pl-3">
          <Button size="sm" variant="ghost" className="text-muted" onClick={() => setAdding(true)}>
            + Listen for…
          </Button>
        </div>
      </WorkList>
      {adding && (
        <AutomationWizard
          open
          onOpenChange={setAdding}
          preselectedPlace={{ subject: block.subject, service: block.service, label: wizardLabel }}
        />
      )}
    </section>
  );
}
