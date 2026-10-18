/**
 * A routine as a row of the overview roster's `On a schedule` group
 * (docs/specs/2026-10-16-presence-hub-design.md Part B step 6, Part E step
 * 1). It uses the same grid as a place row. The place column holds the
 * schedule in words, then the timezone when it is not UTC, then `Next
 * <time>` or `Off`. The sentence column holds `<name>: <do>.` linked to the
 * routine's page, the prompt under it, and at the right Fire now, a small
 * on/off switch, and the overflow menu (Edit, Delete). A routine that the
 * scheduler turned off carries the danger mark and its fix under the row.
 */
import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { MoreHorizontal } from "lucide-react";
import { useMe, useTeams } from "~/api/settings";
import { usePinnedThreadTitle } from "~/api/rule";
import { useDeleteSchedule } from "~/api/workflows";
import {
  Button, ConfirmDialog, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, Switch,
} from "~/components/primitives";
import { TriggerDialog } from "~/components/workflows/trigger-dialog";
import { cn } from "~/lib/cn";
import { errorText } from "~/lib/error-text";
import { PLACE_META_CLASS, PLACE_NAME_CLASS, ROSTER_ROW_CLASS } from "./place-row";
import { ThreadProblem } from "./problem-badge";
import { routineReadOnly } from "./routine-page";
import { routineWhen, useRoutineActions, type Routine } from "./routine-helpers";
import { cronInWords, scheduleZone } from "./sentences";

export function RoutineRosterRow({ routine, sentence, now, children }: {
  routine: Routine;
  /** `<name>: <do>.` */
  sentence: string;
  /** The clock for `Next <time>`; tests pin it. */
  now?: number;
  /** Ends the sentence column, such as `+ New routine` on the group's last row. */
  children?: ReactNode;
}) {
  const me = useMe();
  const teams = useTeams();
  const readOnly = routineReadOnly(routine, me.data, teams.data?.teams);
  const { fire, update, message, fireNow, save, setEnabled } = useRoutineActions(routine);
  const remove = useDeleteSchedule();
  const pin = routine.detail.thread?.mode === "existing" ? routine.detail.thread : undefined;
  const pinTitles = usePinnedThreadTitle(pin);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const schedule = cronInWords(routine.detail.cron);
  const zone = scheduleZone(routine.detail.timezone);
  const problem = routine.detail.disabledReason ?? "";
  const { ownerType, ownerId } = routine.detail;
  // The picker lists the routine owner's threads, whatever the switcher shows.
  const workspace = ownerType === "user" ? "user" : ownerType === "team" ? ownerId : undefined;
  const prompt = routine.detail.prompt?.trim() ?? "";

  return (
    <section aria-label={routine.name} className={ROSTER_ROW_CLASS}>
      <div className="min-w-0 pt-0.5">
        <p className={PLACE_NAME_CLASS}>{schedule}</p>
        <div className={PLACE_META_CLASS}>
          {zone !== undefined && <span>{zone}</span>}
          <span>{routineWhen(routine, " ", now)}</span>
        </div>
      </div>
      <div className="grid min-w-0 gap-0.5">
        <div className="-mx-2 grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-0.5 rounded-md px-2 py-1.5 hover:bg-ink-wash">
          <div className="min-w-0">
            <p className="text-base [overflow-wrap:anywhere]">
              {problem !== "" && <span aria-hidden="true" className="mr-2 inline-block h-2 w-2 rounded-full bg-danger-500 align-[2px]" />}
              <Link
                to="/presence/routines/$id"
                params={{ id: routine.id }}
                className={cn("text-base hover:underline", routine.enabled ? "text-ink" : "text-muted")}
              >
                {sentence}
              </Link>
            </p>
            {prompt !== "" && <p className="mt-px line-clamp-2 text-xs text-muted [overflow-wrap:anywhere]">{prompt}</p>}
          </div>
          <div className="flex items-center gap-2 pt-1">
            <Button
              size="sm"
              variant="ghost"
              className="h-auto px-1.5 py-0.5 text-xs font-normal text-muted hover:text-ink"
              disabled={readOnly || fire.isPending}
              onClick={fireNow}
              aria-label={`Fire ${routine.name} now`}
            >
              Fire now
            </Button>
            <Switch
              size="sm"
              checked={routine.enabled}
              disabled={readOnly || update.isPending}
              onCheckedChange={setEnabled}
              aria-label={`${routine.enabled ? "Turn off" : "Turn on"} ${routine.name}`}
            />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="icon" aria-label={`More for ${routine.name}`}>
                  <MoreHorizontal className="h-4 w-4" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem disabled={readOnly} onSelect={() => setEditing(true)}>Edit</DropdownMenuItem>
                <DropdownMenuItem
                  disabled={readOnly}
                  className="text-danger-500"
                  onSelect={() => {
                    // React Query holds `error` until the next mutate, so
                    // without this the last refusal greets the next open.
                    remove.reset();
                    setDeleting(true);
                  }}
                >
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {problem !== "" && (
            <div className="col-span-full">
              <ThreadProblem
                variant="inline"
                problem={problem}
                threadTitle={pin ? pinTitles[pin.threadId]?.title ?? undefined : undefined}
                workspace={workspace}
                readOnly={readOnly}
                onPick={(thread) => save({ thread, enabled: true })}
                pending={update.isPending}
              />
            </div>
          )}
          {message && (
            <p role={message.error ? "alert" : "status"} className={cn("col-span-full text-xs", message.error ? "text-danger-500" : "text-muted")}>
              {message.text}
            </p>
          )}
        </div>
        {children}
      </div>
      {editing && <TriggerDialog open onOpenChange={setEditing} editing={routine} schedulesOnly />}
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete "${routine.name}"?`}
        description="Valet stops acting on this schedule. Its past runs stay."
        confirmLabel="Delete"
        pendingLabel="Deleting…"
        pending={remove.isPending}
        error={remove.error ? errorText(remove.error) : undefined}
        onConfirm={() => remove.mutate(routine.id, { onSuccess: () => setDeleting(false) })}
      />
    </section>
  );
}
