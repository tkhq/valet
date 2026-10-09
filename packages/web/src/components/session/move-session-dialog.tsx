import { useState } from "react";
import type { AssistantOwner, BackgroundWorkConflict, BackgroundWorkItem } from "@valet/api/wire";
import { backgroundWorkConflict } from "~/api/client";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  SelectMenu,
} from "~/components/primitives";
import { useMoveSession, useSessionWakeups } from "~/api/queries";
import { useOrg, useTeams } from "~/api/settings";
import { eligibleTeams } from "~/components/session/assistant-rail";
import { errorText } from "~/lib/error-text";
import { PERSONAL } from "~/lib/workspace-scope";
import { backgroundItems } from "./background-work-badge";
import { BackgroundWorkList } from "./background-work-confirm";

/**
 * "Move to workspace…" — reassigns a standalone session between the
 * caller's own workspace and their teams (`PATCH /:id` with `teamId`).
 *
 * This is also the migration path: before the workspace-aware create
 * landed, the web UI could only make personal sessions, so every existing
 * session sits in Personal regardless of whose work it holds.
 *
 * Assistant sessions never get this dialog — an assistant's session is
 * addressed by its owner (`assistant:{id}`), so its owner is structural,
 * not a property to edit.
 *
 * A move stops every wakeup and hold of the session (fix wave 3, H2): a
 * signal turn would otherwise run as the new owner. The dialog lists that
 * work from the polled list, which can be a minute old, so the first
 * submit never sends `force` (fix wave 4, N9). The server's 409 then
 * names the work as it is now and switches the button to the confirm,
 * which sends `force`. After a forced move the dialog stays open to say
 * how many items stopped.
 */
export function MoveSessionDialog({
  sessionId,
  owner,
  open,
  onOpenChange,
}: {
  sessionId: string;
  /** The session's current owner, so the picker starts where the row is. */
  owner: AssistantOwner;
  open: boolean;
  onOpenChange: (next: boolean) => void;
}) {
  const teamsQ = useTeams();
  const orgQ = useOrg();
  const move = useMoveSession(sessionId);
  const workQ = useSessionWakeups(sessionId);
  const [conflict, setConflict] = useState<BackgroundWorkConflict | null>(null);
  const [stoppedCount, setStoppedCount] = useState<number | null>(null);

  const teams = eligibleTeams(teamsQ.data?.teams, orgQ.data?.features.organizations);
  const currentKey = owner.type === "team" ? owner.id : PERSONAL;
  const [selected, setSelected] = useState(currentKey);

  const options = [
    { value: PERSONAL, label: "Personal" },
    ...teams.map((t) => ({ value: t.id, label: t.name })),
  ];
  const selectedTeam = teams.find((t) => t.id === selected);
  const unchanged = selected === currentKey;
  // The server's refusal is newer than the polled list, so it wins.
  const work: BackgroundWorkItem[] = conflict ? conflict.work : backgroundItems(workQ.data);
  const blocked = conflict !== null && !conflict.forceAllowed;
  // Only a fresh refusal may be forced: it names the work the confirm stops.
  const force = conflict !== null && conflict.forceAllowed;

  function submit() {
    if (unchanged) {
      onOpenChange(false);
      return;
    }
    const teamId = selected === PERSONAL ? null : selected;
    move.mutate(
      { teamId, ...(force ? { force: true } : {}) },
      {
        onSuccess: (moved) => {
          if (moved.cancelledWorkCount !== undefined && moved.cancelledWorkCount > 0) {
            setStoppedCount(moved.cancelledWorkCount);
          } else {
            onOpenChange(false);
          }
        },
        onError: (err) => setConflict(backgroundWorkConflict(err)),
      },
    );
  }

  if (stoppedCount !== null) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent title="Move to workspace" description="Who can open it changed.">
          <p className="text-xs text-ink">
            {`Moved. Stopped ${stoppedCount} background ${stoppedCount === 1 ? "item" : "items"}. The agent got a message about it.`}
          </p>
          <DialogFooter>
            <Button type="button" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  // No reset machinery: the header mounts this dialog only while it is
  // open (`{moving && …}`), so every open is a fresh mount and `selected`
  // initializes from the row's real owner above. A close-time or open-time
  // reset would be dead code — and dead resets read as load-bearing.
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Move to workspace"
        description="The runtime keeps its threads, history, and sandbox. Who can open it changes."
      >
        <SelectMenu
          value={selected}
          onChange={setSelected}
          triggerLabel={options.find((o) => o.value === selected)?.label ?? "Pick a workspace"}
          options={options}
        />
        <p className="text-xs text-muted">
          {selectedTeam
            ? `Everyone on ${selectedTeam.name} can read its threads and send messages. Team admins can manage it.`
            : "Only you can open it."}
        </p>
        {work.length > 0 && (
          <>
            <p className="text-xs text-ink">
              Moving stops this background work. The agent gets a message that you stopped it.
            </p>
            <BackgroundWorkList items={work} />
          </>
        )}
        {conflict !== null && conflict.hiddenCount > 0 && (
          <p className="text-xs text-muted">
            {conflict.hiddenCount === 1
              ? "1 more item runs on a thread you cannot see."
              : `${conflict.hiddenCount} more items run on threads you cannot see.`}
          </p>
        )}
        {blocked && <p className="text-xs text-danger-500">{conflict.error}</p>}
        {move.error != null && conflict === null && <p className="text-xs text-danger-500">{errorText(move.error)}</p>}
        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={move.isPending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant={force ? "danger" : undefined}
            onClick={submit}
            disabled={unchanged || move.isPending || blocked}
          >
            {move.isPending ? "Moving…" : force ? "Stop background work and move" : "Move runtime"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
