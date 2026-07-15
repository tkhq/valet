import { createFileRoute } from "@tanstack/react-router";
import type { NotificationKind } from "@valet/api/wire";
import { useNotificationPreferences, useSetNotificationPreference } from "~/api/queries";
import { Section } from "~/components/settings/section";
import { FieldRow } from "~/components/settings/field-row";
import { Spinner, Switch } from "~/components/primitives";

/**
 * `/settings/notifications` — You · Notifications. Per-kind web delivery
 * toggle, carried over verbatim-ish from the old flat `/settings` page
 * (Task 6 restyles this into the new section layout; behavior unchanged).
 */
export const Route = createFileRoute("/settings/notifications")({
  component: NotificationsPage,
});

const NOTIFICATION_KINDS: NotificationKind[] = [
  "notification",
  "question",
  "escalation",
  "approval",
];

const KIND_LABEL: Record<NotificationKind, string> = {
  notification: "Notifications",
  question: "Questions",
  escalation: "Escalations",
  approval: "Approvals",
};

const KIND_DESCRIPTION: Record<NotificationKind, string> = {
  notification: "General updates from your assistant.",
  question: "When your assistant needs an answer to keep going.",
  escalation: "When something needs your attention urgently.",
  approval: "When a decision gate is waiting on you.",
};

export function NotificationsPage() {
  const prefsQ = useNotificationPreferences();
  const setPref = useSetNotificationPreference();

  const byKind = new Map(prefsQ.data?.preferences.map((p) => [p.kind, p.web]));

  return (
    <Section title="Notifications" description="Choose which updates reach you here.">
      {prefsQ.isLoading && (
        <div className="flex items-center gap-2 py-4 text-sm text-muted">
          <Spinner size={14} /> Loading…
        </div>
      )}
      {prefsQ.error && (
        <div className="py-4 text-sm text-danger-500">
          Failed to load notification preferences.
        </div>
      )}
      {!prefsQ.isLoading &&
        !prefsQ.error &&
        NOTIFICATION_KINDS.map((kind) => {
          // Web delivery defaults to on until the caller has an explicit
          // row — mirrors the API's own default (see notifications.ts).
          const web = byKind.get(kind) ?? true;
          return (
            <FieldRow key={kind} label={KIND_LABEL[kind]} hint={KIND_DESCRIPTION[kind]}>
              <Switch
                checked={web}
                onCheckedChange={(next) => setPref.mutate({ kind, web: next })}
                aria-label={`${KIND_LABEL[kind]} web notifications`}
              />
            </FieldRow>
          );
        })}
    </Section>
  );
}
