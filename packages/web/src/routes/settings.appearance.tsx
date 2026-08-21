import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Monitor, Sun, Moon } from "lucide-react";
import { Section } from "~/components/settings/section";
import { RadioCard } from "~/components/settings/radio-card";
import {
  getToolCardDefault,
  setToolCardDefault,
  type ToolCardDefault,
} from "~/lib/preferences";
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
 * `/settings/appearance` — You · Appearance. Three independent choices,
 * each a row of `RadioCard`s (moss ring when selected): the light/dark
 * polarity, the color palette, and the chat density. `~/lib/theme.ts` owns
 * the first two mechanisms. `~/lib/preferences.ts` owns the third.
 *
 * The polarity and the palette are deliberately not merged into one list of
 * six or more cards. Every palette has a light and a dark form, so a single
 * list would force the reader to give up their light/dark decision to
 * change color.
 *
 * Chat density sits here because it is a per-browser look choice, like the
 * two above it. It writes through `setToolCardDefault`, so this page adds
 * no persistence path of its own.
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

/** One card per policy. The collapse spec dated 2026-08-20 in
 * `docs/specs/` holds the full interaction matrix. The descriptions name
 * what a card does at mount and on completion, because those are the two
 * moments a reader notices. Each one states that errors stay readable, so
 * nobody reads a collapse setting as a way to lose an error message. */
const TOOL_CARD_OPTIONS: { value: ToolCardDefault; label: string; description: string }[] = [
  {
    value: "smart",
    label: "Smart",
    description: "Running expanded, completed cards collapse when they finish. Errors stay expanded.",
  },
  {
    value: "always-collapsed",
    label: "Always collapsed",
    description: "Everything collapsed at mount, including running. Errors still open.",
  },
  {
    value: "always-expanded",
    label: "Always expanded",
    description: "Everything expanded and stays.",
  },
];

export function AppearancePage() {
  const [choice, setChoice] = useState<ThemeChoice>(() => readStoredTheme());
  const [palette, setPaletteChoice] = useState<PaletteChoice>(() => readStoredPalette());
  const [toolCard, setToolCard] = useState<ToolCardDefault>(() => getToolCardDefault());

  function choose(next: ThemeChoice) {
    setChoice(next);
    setTheme(next);
  }

  function choosePalette(next: PaletteChoice) {
    setPaletteChoice(next);
    setPalette(next);
  }

  function chooseToolCard(next: ToolCardDefault) {
    setToolCard(next);
    setToolCardDefault(next);
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

      <div className="space-y-3 py-4">
        <p className="text-sm font-medium text-ink">Chat density</p>
        <div role="radiogroup" aria-label="Chat density" className="grid gap-2 sm:grid-cols-3">
          {TOOL_CARD_OPTIONS.map((opt) => (
            <RadioCard
              key={opt.value}
              title={opt.label}
              description={opt.description}
              selected={toolCard === opt.value}
              onSelect={() => chooseToolCard(opt.value)}
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
