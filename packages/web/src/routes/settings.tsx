import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import type { NotificationKind } from "@valet/api/wire";
import { useNotificationPreferences, useSetNotificationPreference } from "~/api/queries";
import { Spinner, Switch } from "~/components/primitives";
import { readStoredTheme, setTheme, type ThemeChoice } from "~/lib/theme";
import { cn } from "~/lib/cn";

/**
 * `/settings` — Appearance (theme choice) + Notifications (per-kind web
 * delivery toggle). Reached via the gear icon in the top nav.
 */
export const Route = createFileRoute("/settings")({
  component: SettingsPage,
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

function SettingsPage() {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-xl px-6 py-10 space-y-10">
        <h1 className="font-display text-2xl text-ink">Settings</h1>
        <AppearanceSection />
        <NotificationsSection />
      </div>
    </div>
  );
}

const THEME_OPTIONS: { value: ThemeChoice; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

function AppearanceSection() {
  const [choice, setChoice] = useState<ThemeChoice>(() => readStoredTheme());

  function choose(next: ThemeChoice) {
    setChoice(next);
    setTheme(next);
  }

  return (
    <section className="space-y-3">
      <h2 className="font-display text-base text-ink">Appearance</h2>
      <div
        role="radiogroup"
        aria-label="Theme"
        className="inline-flex rounded border border-line bg-paper p-0.5"
      >
        {THEME_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={choice === opt.value}
            onClick={() => choose(opt.value)}
            className={cn(
              "rounded px-3 py-1.5 text-sm transition-colors",
              choice === opt.value
                ? "bg-neutral-200 dark:bg-neutral-800 text-ink"
                : "text-muted hover:text-ink",
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </section>
  );
}

function NotificationsSection() {
  const prefsQ = useNotificationPreferences();
  const setPref = useSetNotificationPreference();

  const byKind = new Map(prefsQ.data?.preferences.map((p) => [p.kind, p.web]));

  return (
    <section className="space-y-3">
      <h2 className="font-display text-base text-ink">Notifications</h2>
      {prefsQ.isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted">
          <Spinner size={14} /> Loading…
        </div>
      )}
      {prefsQ.error && (
        <div className="text-sm text-danger-500">Failed to load notification preferences.</div>
      )}
      {!prefsQ.isLoading && !prefsQ.error && (
        <ul className="divide-y divide-line rounded border border-line">
          {NOTIFICATION_KINDS.map((kind) => {
            // Web delivery defaults to on until the caller has an explicit
            // row — mirrors the API's own default (see notifications.ts).
            const web = byKind.get(kind) ?? true;
            return (
              <li key={kind} className="flex items-center justify-between gap-4 px-4 py-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-ink">{KIND_LABEL[kind]}</div>
                  <div className="text-xs text-muted">{KIND_DESCRIPTION[kind]}</div>
                </div>
                <Switch
                  checked={web}
                  onCheckedChange={(next) => setPref.mutate({ kind, web: next })}
                  aria-label={`${KIND_LABEL[kind]} web notifications`}
                />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
