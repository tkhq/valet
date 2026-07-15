import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Monitor, Sun, Moon } from "lucide-react";
import { Section } from "~/components/settings/section";
import { RadioCard } from "~/components/settings/radio-card";
import { readStoredTheme, setTheme, type ThemeChoice } from "~/lib/theme";

/**
 * `/settings/appearance` — You · Appearance. Theme choice, restyled per the
 * spec's "Visual direction" into three `RadioCard`s (moss ring when
 * selected); the underlying `~/lib/theme.ts` mechanism is unchanged from
 * the old flat `/settings` page.
 */
export const Route = createFileRoute("/settings/appearance")({
  component: AppearancePage,
});

const THEME_OPTIONS: { value: ThemeChoice; label: string; description: string; icon: typeof Monitor }[] = [
  { value: "system", label: "System", description: "Follows your device's setting.", icon: Monitor },
  { value: "light", label: "Light", description: "Bright, paper-toned surfaces.", icon: Sun },
  { value: "dark", label: "Dark", description: "Low-glare, dark surfaces.", icon: Moon },
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
        <div role="radiogroup" aria-label="Theme" className="flex flex-col gap-2 sm:flex-row">
          {THEME_OPTIONS.map((opt) => (
            <RadioCard
              key={opt.value}
              title={opt.label}
              description={opt.description}
              selected={choice === opt.value}
              onSelect={() => choose(opt.value)}
              icon={<opt.icon className="h-4 w-4" />}
            />
          ))}
        </div>
      </div>
    </Section>
  );
}
