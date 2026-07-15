import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Section } from "~/components/settings/section";
import { readStoredTheme, setTheme, type ThemeChoice } from "~/lib/theme";
import { cn } from "~/lib/cn";

/**
 * `/settings/appearance` — You · Appearance. Theme choice, carried over
 * verbatim-ish from the old flat `/settings` page (Task 6 restyles this as
 * the spec's `radio-card` pattern; behavior is unchanged here).
 */
export const Route = createFileRoute("/settings/appearance")({
  component: AppearancePage,
});

const THEME_OPTIONS: { value: ThemeChoice; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export function AppearancePage() {
  const [choice, setChoice] = useState<ThemeChoice>(() => readStoredTheme());

  function choose(next: ThemeChoice) {
    setChoice(next);
    setTheme(next);
  }

  return (
    <Section title="Appearance" description="Choose how Valet looks on this device.">
      <div className="py-4">
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
      </div>
    </Section>
  );
}
