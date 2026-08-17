import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Monitor, Sun, Moon } from "lucide-react";
import { Section } from "~/components/settings/section";
import { RadioCard } from "~/components/settings/radio-card";
import {
  readStoredPalette,
  readStoredTheme,
  setPalette,
  setTheme,
  themeAttributeValue,
  type PaletteChoice,
  type ThemeChoice,
} from "~/lib/theme";

/**
 * `/settings/appearance` — You · Appearance. Two independent choices, each
 * a row of `RadioCard`s (moss ring when selected): the light/dark polarity,
 * and the color palette. `~/lib/theme.ts` owns both mechanisms.
 *
 * The two are deliberately not merged into one list of six or more cards.
 * Every palette has a light and a dark form, so a single list would force
 * the reader to give up their light/dark decision to change color.
 */
export const Route = createFileRoute("/settings/appearance")({
  component: AppearancePage,
});

const THEME_OPTIONS: { value: ThemeChoice; label: string; description: string; icon: typeof Monitor }[] = [
  { value: "system", label: "System", description: "Follows your device's setting.", icon: Monitor },
  { value: "light", label: "Light", description: "Bright, paper-toned surfaces.", icon: Sun },
  { value: "dark", label: "Dark", description: "Low-glare, dark surfaces.", icon: Moon },
];

/** Descriptions avoid the words the polarity cards use, so a reader
 * scanning the page never sees "light" or "dark" mean two things. */
const PALETTE_OPTIONS: { value: PaletteChoice; label: string; description: string }[] = [
  { value: "default", label: "Default", description: "Valet blue on cool grey." },
  { value: "ember", label: "Ember", description: "Burnt orange on warm sand." },
  { value: "tide", label: "Tide", description: "Teal on sea grey." },
  { value: "orchid", label: "Orchid", description: "Violet on soft lilac." },
];

export function AppearancePage() {
  const [choice, setChoice] = useState<ThemeChoice>(() => readStoredTheme());
  const [palette, setPaletteChoice] = useState<PaletteChoice>(() => readStoredPalette());

  function choose(next: ThemeChoice) {
    setChoice(next);
    setTheme(next);
  }

  function choosePalette(next: PaletteChoice) {
    setPaletteChoice(next);
    setPalette(next);
  }

  return (
    <Section title="Appearance" description="Choose how Valet looks on this device.">
      <div className="space-y-3 py-4">
        <p className="text-sm font-medium text-ink">Light and dark</p>
        <div role="radiogroup" aria-label="Light and dark" className="flex flex-col gap-2 sm:flex-row">
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

      <div className="space-y-3 py-4">
        <p className="text-sm font-medium text-ink">Color palette</p>
        <div role="radiogroup" aria-label="Color palette" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {PALETTE_OPTIONS.map((opt) => (
            <RadioCard
              key={opt.value}
              title={opt.label}
              description={opt.description}
              selected={palette === opt.value}
              onSelect={() => choosePalette(opt.value)}
              icon={<PaletteSwatch palette={opt.value} choice={choice} />}
            />
          ))}
        </div>
      </div>
    </Section>
  );
}

/**
 * A miniature surface painted in the palette it advertises, so the reader
 * sees the colors before choosing them: the palette's paper and hairline,
 * its accent, and two text weights.
 *
 * The colors come from `theme.css`, not from a table in this file — the
 * span carries `data-palette`, which the palette blocks select on, and its
 * children read the tokens the span then declares. Here `default` is a
 * written-out value, unlike on `<html>` where the default palette is an
 * absent attribute: the swatch must paint one named palette whatever the
 * page is set to. It still mirrors the reader's own polarity, and leaves
 * `data-theme` off for `system` so it follows the OS as the page does.
 */
function PaletteSwatch({ palette, choice }: { palette: PaletteChoice; choice: ThemeChoice }) {
  return (
    <span
      className="palette-swatch flex h-6 w-10 items-center gap-1 rounded border border-line bg-paper px-1"
      data-palette={palette}
      data-theme={themeAttributeValue(choice) ?? undefined}
    >
      <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-moss" />
      <span className="flex flex-1 flex-col gap-0.5">
        <span className="h-1 w-full rounded-full bg-ink" />
        <span className="h-1 w-2/3 rounded-full bg-muted" />
      </span>
    </span>
  );
}
