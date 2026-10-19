/**
 * A place row of the overview roster
 * (docs/specs/2026-10-16-presence-hub-design.md Part B steps 4, 5, and 11):
 * one row of a two-column grid. The place column holds the place's name as
 * a link to its page, then on separate lines the active threads (when any
 * wait) and the time of the last activity. In a team workspace, a Slack
 * row's overflow menu offers `Choose channels`, which opens the team's
 * channel dialog (`TeamSlackSetupModal`, the dialog `ListenButton` opens). The sentence column holds one sentence row per
 * line of presence, one `Appears as` line when a line sets an appearance,
 * and a quiet `+ Listen for…` that opens the editor fixed on the place. At
 * phone width the place column stacks above the sentence column. The row
 * names the place, so a sentence leaves out its `<in|on> <place>` clause.
 */
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { MoreHorizontal } from "lucide-react";
import type { EventSubscriptionWire } from "@valet/api/wire";
import { TeamSlackSetupModal } from "~/components/events/team-slack-setup";
import {
  Avatar, AvatarFallback, AvatarImage, Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "~/components/primitives";
import { cn } from "~/lib/cn";
import { relativeTime } from "~/lib/relative-time";
import { useWorkspaceScope } from "~/lib/workspace-scope";
import { announceCreated } from "./created-highlight";
import { LineEditor } from "./editor/line-editor";
import type { PlaceBlockData } from "./overview-groups";
import { PresenceLine } from "./presence-line";
import { appearanceName, hasAppearance, usePresenceSentenceParts } from "./presence-rows";
import { SERVICE_NAMES } from "./places";
import { SENTENCE_PLACE_FIELD_SET } from "./sentences";

/** The mark on a row or a group that a Create just added to (spec Part H
 * step 9). It is a color, not motion, so reduced motion needs no case. */
export const CREATED_HIGHLIGHT_CLASS = "bg-moss-wash";

/** The roster's grid: a 200px place column and the sentence column; one column at phone width. */
export const ROSTER_ROW_CLASS =
  "grid grid-cols-[200px_minmax(0,1fr)] gap-x-8 gap-y-1 border-b border-line py-4 last:border-0 max-sm:grid-cols-1 max-sm:gap-y-2";

/** The quiet add button at the end of a sentence column. */
export const QUIET_ADD_CLASS =
  "-ml-2 mt-1 h-auto justify-self-start rounded-md px-2 py-1 text-xs font-normal text-muted hover:bg-moss-wash hover:text-accent-600";

/** The place name in the place column. */
export const PLACE_NAME_CLASS = "break-words text-[15px] font-medium text-ink";

/** The stacked meta lines under the place name; one line at phone width. */
export const PLACE_META_CLASS = "mt-1.5 grid gap-0.5 text-xs tabular-nums text-muted max-sm:mt-0.5 max-sm:flex max-sm:flex-wrap max-sm:gap-x-3";

/**
 * True when a row keeps its place clause. A place row names its place,
 * so its sentences drop the clause. A service row names no place, so a line
 * there that names places (`in #a or #b`) keeps them.
 */
export function keepsPlaceClause(block: Pick<PlaceBlockData, "serviceWide">, line: Pick<EventSubscriptionWire, "filters">): boolean {
  return block.serviceWide && line.filters.some((filter) => SENTENCE_PLACE_FIELD_SET.has(filter.field) && (filter.op === "eq" || filter.op === "in"));
}

/** The service row for Slack with no Slack row in the places list has no page to open. */
function hasPage(block: PlaceBlockData): boolean {
  return block.subject !== "slack:*";
}

/** `1 active thread` or `2 active threads`. A place with none says nothing. */
export function activeThreadsText(count: number): string | null {
  if (count <= 0) return null;
  return count === 1 ? "1 active thread" : `${count} active threads`;
}

export function PlaceRow({ block, highlighted = false }: {
  block: PlaceBlockData;
  /** True for two seconds after a Create adds a line to this place. */
  highlighted?: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const { teamId } = useWorkspaceScope();
  // A team picks its Slack channels from any Slack row (spec Part B step 4).
  const choosesChannels = teamId !== undefined && block.service === "slack";
  const sentence = usePresenceSentenceParts(block.lines);
  const active = activeThreadsText(block.activeThreadCount);
  const placeLabel = block.serviceWide ? SERVICE_NAMES[block.service] : block.label;
  const appearing = block.lines.find(hasAppearance);
  return (
    <section
      aria-label={block.label}
      data-highlight={highlighted ? "true" : undefined}
      className={cn(ROSTER_ROW_CLASS, "transition-colors", highlighted && CREATED_HIGHLIGHT_CLASS)}
    >
      <div className="min-w-0 pt-0.5">
        <div className="flex items-start justify-between gap-2">
          {hasPage(block)
            ? (
              <Link to="/presence/places/$subject" params={{ subject: block.subject }} className={`${PLACE_NAME_CLASS} hover:underline`}>
                {block.label}
              </Link>
            )
            : <span className={PLACE_NAME_CLASS}>{block.label}</span>}
          {choosesChannels && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="icon" className="-mt-1 h-7 w-7 shrink-0" aria-label={`More for ${block.label}`}>
                  <MoreHorizontal className="h-4 w-4" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setChoosing(true)}>Choose channels</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        {(active !== null || block.lastActivityAt !== null) && (
          <div className={PLACE_META_CLASS}>
            {active !== null && (
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-moss" />
                {active}
              </span>
            )}
            {block.lastActivityAt !== null && <span>{relativeTime(block.lastActivityAt)}</span>}
          </div>
        )}
      </div>
      <div className="grid min-w-0 gap-0.5">
        {block.lines.map((line) => (
          <PresenceLine
            key={line.id}
            sub={line}
            sentence={sentence(line, { place: keepsPlaceClause(block, line), appearance: !sameAppearance(line, appearing) })}
          />
        ))}
        {appearing !== undefined && <AppearsAs sub={appearing} />}
        <Button size="sm" variant="ghost" className={QUIET_ADD_CLASS} onClick={() => setAdding(true)}>
          + Listen for…
        </Button>
      </div>
      {choosing && teamId !== undefined && <TeamSlackSetupModal key={teamId} teamId={teamId} onOpenChange={setChoosing} />}
      <LineEditor
        open={adding}
        onOpenChange={setAdding}
        onSaved={announceCreated}
        mode={{ kind: "create", preselected: { place: { subject: block.subject, service: block.service, label: placeLabel } } }}
      />
    </section>
  );
}

/** True when a line appears as the place's `Appears as` line already says, so its sentence drops `, as <name>`. */
function sameAppearance(line: EventSubscriptionWire, shown: EventSubscriptionWire | undefined): boolean {
  if (shown === undefined || !hasAppearance(line)) return false;
  return appearanceName(line) === appearanceName(shown)
    && (line.target.appearance?.avatarUrl?.trim() ?? "") === (shown.target.appearance?.avatarUrl?.trim() ?? "");
}

/** The one `Appears as <name>` line of a place, with a 16px avatar. */
function AppearsAs({ sub }: { sub: EventSubscriptionWire }) {
  const name = appearanceName(sub);
  const avatarUrl = sub.target.appearance?.avatarUrl?.trim();
  return (
    <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
      <Avatar size="sm" className="h-4 w-4 text-[9px]">
        {avatarUrl && <AvatarImage src={avatarUrl} alt="" />}
        <AvatarFallback>{name.charAt(0).toUpperCase()}</AvatarFallback>
      </Avatar>
      {`Appears as ${name}`}
    </p>
  );
}
