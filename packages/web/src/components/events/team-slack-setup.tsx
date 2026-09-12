import { useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMe, useTeams } from "~/api/settings";
import { usePlugins } from "~/api/integrations";
import { useEventSubscriptions } from "~/api/events";
import { Button, Dialog, DialogContent } from "~/components/primitives";
import { AutomationWizard } from "./automation-wizard";
import { selectsSlackMention } from "~/lib/slack-mention";

/** Mount by team ID so changing workspace closes setup and discards selections. */
export function TeamSlackSetupCard({ teamId }: { teamId: string }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const closing = useRef(false);
  function changeOpen(value: boolean) {
    closing.current = !value;
    setOpen(value);
  }
  return (
    <section className="flex min-w-0 flex-col gap-4 rounded-lg border border-moss/30 bg-moss/5 p-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-1">
        <h2 className="font-display text-lg text-ink">
          Bring your team orchestrator into Slack
        </h2>
        <p className="text-sm text-muted">
          Let team members mention Valet in Slack and get a reply from your
          orchestrator.
        </p>
      </div>
      <Button ref={trigger} className="shrink-0" onClick={() => changeOpen(true)}>
        Set up Slack replies
      </Button>
      {open && (
        <TeamSlackSetupModal
          teamId={teamId}
          onOpenChange={changeOpen}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            // Loading and the wizard use separate dialog contents. Only
            // restore the trigger when setup closes, not between those states.
            if (closing.current) trigger.current?.focus();
          }}
        />
      )}
    </section>
  );
}

export function TeamSlackSetupModal({
  teamId,
  onOpenChange,
  onCloseAutoFocus,
}: {
  teamId: string;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const [addAnother, setAddAnother] = useState(false);
  const teamsQ = useTeams();
  const meQ = useMe();
  const pluginsQ = usePlugins();
  const subscriptionsQ = useEventSubscriptions({
    ownerType: "team",
    ownerId: teamId,
  });
  const team = teamsQ.data?.teams.find((candidate) => candidate.id === teamId);
  const slack = pluginsQ.data?.plugins
    .flatMap((plugin) => plugin.services)
    .find((service) => service.service === "slack");
  const existing =
    subscriptionsQ.data?.subscriptions.filter(
      (rule) =>
        rule.ownerType === "team" &&
        rule.ownerId === teamId &&
        selectsSlackMention(rule.eventKeys) &&
        rule.target.kind === "orchestrator" &&
        rule.target.orchestrator === "team" &&
        rule.target.teamId === teamId,
    ) ?? [];
  let notice;
  if (teamsQ.error || pluginsQ.error || subscriptionsQ.error) {
    notice = (
      <p role="alert">
        Could not load Slack setup. Close this dialog and try again.
      </p>
    );
  } else if (!teamsQ.data || !pluginsQ.data || !subscriptionsQ.data) {
    notice = <p role="status">Loading Slack setup…</p>;
  } else if (!team?.callerRole) {
    notice = (
      <p role="alert">
        You must be a member of this team to set up replies. Select a team you
        belong to.
      </p>
    );
  } else if (slack?.connect !== "org") {
    notice = (
      <p>
        The organization Slack bot is not connected.{" "}
        {meQ.data?.orgRole === "admin" ? (
          <>
            Connect it in{" "}
            <Link to="/settings/organization/slack" className="underline">
              Organization Settings → Slack
            </Link>
            .
          </>
        ) : (
          "Ask an organization admin to connect it in Organization Settings → Slack."
        )}
      </p>
    );
  } else if (existing.length > 0 && !addAnother) {
    notice = (
      <div className="space-y-3">
        <p>
          Slack replies already have rules for this team. Review them before
          adding another.
        </p>
        <ul className="list-disc pl-5">
          {existing.map((rule) => (
            <li key={rule.id} className="break-words">
              {rule.name}
              {!rule.enabled && " (disabled)"}
            </li>
          ))}
        </ul>
        <p>
          <Link to="/events" className="underline">
            Open Events
          </Link>
          , then select Subscriptions to edit or enable the existing rules.
        </p>
        <Button variant="secondary" onClick={() => setAddAnother(true)}>
          Add another reply rule
        </Button>
      </div>
    );
  } else {
    return (
      <AutomationWizard
        key={teamId}
        open
        onOpenChange={onOpenChange}
        replyTeam={{ id: team.id, name: team.name }}
        onCloseAutoFocus={onCloseAutoFocus}
      />
    );
  }
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        onCloseAutoFocus={onCloseAutoFocus}
        title="Set up Slack replies"
        description="Use your organization's Slack bot for team replies."
        className="max-w-lg"
      >
        <div className="text-sm leading-relaxed text-muted">{notice}</div>
      </DialogContent>
    </Dialog>
  );
}
