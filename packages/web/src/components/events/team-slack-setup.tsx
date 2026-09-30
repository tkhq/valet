import { useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Hash } from "lucide-react";
import { useMe, useTeams } from "~/api/settings";
import { usePlugins } from "~/api/integrations";
import { useCreateEventSubscription, useEventSubscriptions, useFilterOptions } from "~/api/events";
import { Button, Dialog, DialogContent, DialogFooter, Input } from "~/components/primitives";
import { errorText } from "~/lib/error-text";
import { listenerFor, slackChannelListeners } from "~/lib/slack-listeners";
import { SLACK_APP_MENTION } from "~/lib/slack-mention";
import { AutomationWizard } from "./automation-wizard";

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
          Where should Valet listen?
        </h2>
        <p className="text-sm text-muted">
          Pick the Slack channels where people can mention Valet for this team.
          Personal Valets answer in direct messages.
        </p>
      </div>
      <Button ref={trigger} className="shrink-0" onClick={() => changeOpen(true)}>
        Choose Slack channels
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
  const [advanced, setAdvanced] = useState(false);
  const teamsQ = useTeams();
  const meQ = useMe();
  const pluginsQ = usePlugins();
  // Every mention rule the caller can see, so the picker can show the
  // channels another Valet already answers in.
  const subscriptionsQ = useEventSubscriptions();
  const team = teamsQ.data?.teams.find((candidate) => candidate.id === teamId);
  const slack = pluginsQ.data?.plugins
    .flatMap((plugin) => plugin.services)
    .find((service) => service.service === "slack");
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
  } else if (advanced) {
    return (
      <AutomationWizard
        key={teamId}
        open
        onOpenChange={onOpenChange}
        replyTeam={{ id: team.id, name: team.name }}
        onCloseAutoFocus={onCloseAutoFocus}
      />
    );
  } else {
    return (
      <TeamSlackChannelPicker
        team={{ id: team.id, name: team.name }}
        subscriptions={subscriptionsQ.data.subscriptions}
        teamName={(id) => teamsQ.data?.teams.find((candidate) => candidate.id === id)?.name}
        onOpenChange={onOpenChange}
        onAdvanced={() => setAdvanced(true)}
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

/**
 * A Slack-style channel list: this team's channels show as listening, and a
 * channel another Valet answers in cannot be picked, because two listeners
 * would both reply to one mention. Saving adds one team reply rule for the
 * picked channels, the same rule the advanced setup creates.
 */
export function TeamSlackChannelPicker({
  team,
  subscriptions,
  teamName,
  onOpenChange,
  onAdvanced,
  onCloseAutoFocus,
}: {
  team: { id: string; name: string };
  subscriptions: Parameters<typeof slackChannelListeners>[0];
  teamName: (id: string) => string | undefined;
  onOpenChange: (open: boolean) => void;
  onAdvanced: () => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Map<string, string>>(new Map());
  const channelsQ = useFilterOptions({ source: "slack.channels", q: query });
  const create = useCreateEventSubscription();
  const listeners = useMemo(() => slackChannelListeners(subscriptions, team.id, teamName), [subscriptions, team.id, teamName]);
  const channels = channelsQ.data?.options ?? [];

  function toggle(id: string, label: string) {
    setPicked((current) => {
      const next = new Map(current);
      if (next.has(id)) next.delete(id); else next.set(id, label);
      return next;
    });
  }
  function save() {
    const chosen = [...picked.entries()];
    if (chosen.length === 0) return;
    create.mutate({
      name: `Slack replies for ${team.name}`,
      eventKeys: [SLACK_APP_MENTION],
      filters: chosen.length === 1
        ? [{ field: "channel", op: "eq", value: chosen[0]![0], label: chosen[0]![1] }]
        : [{ field: "channel", op: "in", value: chosen.map(([id]) => id), labels: chosen.map(([, label]) => label) }],
      target: { kind: "orchestrator", orchestrator: "team", teamId: team.id, follow: true },
      audience: "organization",
    }, { onSuccess: () => onOpenChange(false) });
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        onCloseAutoFocus={onCloseAutoFocus}
        title="Where should Valet listen?"
        description={`Pick the Slack channels where people can mention Valet for ${team.name}. Valet replies in the thread and follows it.`}
        className="max-w-lg"
      >
        <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search channels" aria-label="Search channels" />
        <ul aria-label="Slack channels" className="max-h-72 divide-y divide-line overflow-y-auto rounded-md border border-line">
          {channelsQ.isPending && <li className="px-3 py-2 text-sm text-muted">Loading channels…</li>}
          {!channelsQ.isPending && channels.length === 0 && (
            <li className="px-3 py-2 text-sm text-muted">{channelsQ.data?.reason ?? "No channels match. Invite the Valet bot to a channel, then search again."}</li>
          )}
          {channels.map((channel) => {
            const listener = listenerFor(listeners, channel.id);
            const blocked = listener !== undefined;
            return (
              <li key={channel.id}>
                <label className={`flex items-center gap-2 px-3 py-2 text-sm ${blocked ? "text-muted" : "cursor-pointer hover:bg-ink-wash"}`}>
                  <input type="checkbox" disabled={blocked} checked={listener?.kind === "this-team" || picked.has(channel.id)}
                    onChange={() => toggle(channel.id, channel.label)} />
                  <Hash aria-hidden className="h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{channel.label.replace(/^#/, "")}</span>
                  {listener?.kind === "this-team" && <span className="text-xs text-moss">Listening</span>}
                  {listener?.kind === "other" && <span className="text-xs">Taken by {listener.owner}</span>}
                </label>
              </li>
            );
          })}
        </ul>
        {create.error && <p role="alert" className="text-sm text-danger-600">{errorText(create.error)}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={onAdvanced}>Advanced setup</Button>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} disabled={picked.size === 0 || create.isPending}>
            {create.isPending ? "Saving…" : picked.size > 0 ? `Listen in ${picked.size} ${picked.size === 1 ? "channel" : "channels"}` : "Listen in channels"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
