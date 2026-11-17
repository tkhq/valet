import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import type { NotificationKind } from "@valet/api/wire";
import { useNotificationPreferences, useSetNotificationPreference } from "~/api/queries";
import { Section } from "~/components/settings/section";
import { FieldRow } from "~/components/settings/field-row";
import { ErrorRow, LoadingRow, Select, Switch } from "~/components/primitives";
import { Sparkles } from "lucide-react";
import { isAttentionSoundEnabled, setAttentionSoundEnabled } from "~/lib/use-attention-ping";
import {
  isNaviModeEnabled,
  playAttentionChime,
  setNaviModeEnabled,
} from "~/lib/notification-sound";

/** Personal web delivery and optional team direct-message copies, by notification kind. */
export const Route = createFileRoute("/settings/notifications")({
  component: NotificationsPage,
});

const NOTIFICATION_KINDS: NotificationKind[] = [
  "notification",
  "question",
  "escalation",
  "approval",
  "review",
];

const KIND_LABEL: Record<NotificationKind, string> = {
  notification: "Notifications",
  question: "Questions",
  escalation: "Escalations",
  approval: "Approvals",
  review: "Team deletion requests",
};

const KIND_DESCRIPTION: Record<NotificationKind, string> = {
  notification: "General updates from your assistant.",
  question: "When your assistant needs an answer to keep going.",
  escalation: "When something needs your attention urgently.",
  approval: "When a decision gate is waiting on you.",
  review: "When a team resource needs your review before deletion.",
};

export function NotificationsPage() {
  const prefsQ = useNotificationPreferences();
  const setPref = useSetNotificationPreference();
  // Device-local on purpose. Whether a machine may make noise depends on
  // where it is — a desk, a meeting room, a laptop in a cafe — not on who
  // is signed in, so this does not belong on the account.
  const [sound, setSound] = useState(() => isAttentionSoundEnabled());
  // Visually unexplained. See the sparkle button below.
  const [navi, setNavi] = useState(() => isNaviModeEnabled());

  const byKind = new Map(prefsQ.data?.preferences.map((p) => [p.kind, p]));

  return (
    <Section
      title="Notifications"
      description="Choose which updates reach you. While you are active in Valet, direct messages wait for the selected delay. Valet sends no direct message for a notification you already read. Team DM copies are off by default. Turn them on for teams you can access, through your linked messaging account. Approval permissions do not change."
    >
      <FieldRow
        label="Sound"
        hint="Play a short chime when your assistant is blocked and waiting on you. Updates stay silent. This device only."
      >
        <div className="flex items-center gap-3">
          <Switch
            checked={sound}
            onCheckedChange={(next) => {
              setAttentionSoundEnabled(next);
              setSound(next);
              // Play it on the way ON so the choice is audible, and because
              // the click doubles as the gesture that unblocks audio.
              if (next) playAttentionChime();
            }}
            aria-label="Attention sound"
          />
          {/* An easter egg: no visible label, tooltip, or hint text. Faint
              until hovered, softly lit while active. A screen reader still
              hears what it does and whether it is on. It swaps WHICH sound
              plays; the toggle above still decides IF one plays. */}
          <button
            type="button"
            aria-label="Alternate chime"
            aria-pressed={navi}
            onClick={() => {
              const next = !navi;
              setNaviModeEnabled(next);
              setNavi(next);
              // Play whichever sound is now active so the change is audible
              // either way, using the click as the audio-unblock gesture.
              playAttentionChime();
            }}
            className={
              navi
                ? "text-accent-500 drop-shadow-[0_0_6px_currentColor] transition-opacity"
                : "text-muted opacity-25 transition-opacity hover:opacity-70"
            }
          >
            <Sparkles size={14} aria-hidden />
          </button>
        </div>
      </FieldRow>

      {setPref.error && <ErrorRow>Could not save your preference. Try again.</ErrorRow>}
      {prefsQ.isLoading && <LoadingRow />}
      {prefsQ.error && <ErrorRow>Failed to load notification preferences. Reload the page to try again.</ErrorRow>}
      {!prefsQ.isLoading &&
        !prefsQ.error &&
        NOTIFICATION_KINDS.map((kind) => {
          // Web delivery defaults to on until the caller has an explicit
          // row — mirrors the API's own default (see notifications.ts).
          const web = byKind.get(kind)?.web ?? true;
          return (
            <FieldRow key={kind} label={KIND_LABEL[kind]} hint={KIND_DESCRIPTION[kind]}>
              {/* Team DM copies comes last: Team deletion requests has none,
                  so its row drops only the last control and stays aligned. */}
              <div className="flex flex-wrap items-center gap-4"><label className="flex items-center gap-2 text-sm">Web<Switch
                disabled={setPref.isPending}
                checked={web}
                onCheckedChange={(next) => setPref.mutate({ kind, web: next })}
                aria-label={`${KIND_LABEL[kind]} web notifications`}
              /></label>
                <label className="flex items-center gap-2 text-sm">DM delay
                  <Select size="sm" aria-label={`${KIND_LABEL[kind]} DM delay`}
                    disabled={setPref.isPending || !web}
                    value={String(byKind.get(kind)?.channelGraceSeconds)}
                    onChange={e => setPref.mutate({ kind, web, channelGraceSeconds: Number(e.target.value) })}>
                    {[0, 60, 120, 300, 600].map(seconds => <option key={seconds} value={seconds}>{seconds === 0 ? "Immediate" : `${seconds / 60} min`}</option>)}
                    {byKind.get(kind)?.channelGraceSeconds !== undefined && ![0, 60, 120, 300, 600].includes(byKind.get(kind)?.channelGraceSeconds ?? 0) &&
                      <option value={byKind.get(kind)?.channelGraceSeconds}>{byKind.get(kind)?.channelGraceSeconds} sec</option>}
                  </Select>
                </label>
                {kind !== "review" && <label className="flex items-center gap-2 text-sm">Team DM copies<Switch checked={byKind.get(kind)?.teamDm ?? false} disabled={setPref.isPending} onCheckedChange={(teamDm) => setPref.mutate({ kind, web, teamDm })} aria-label={`${KIND_LABEL[kind]} team DM copies`} /></label>}
              </div>
            </FieldRow>
          );
        })}
    </Section>
  );
}
