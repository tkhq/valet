# Brand refresh — decision record

> Retargets the web design tokens onto a real brand identity. Supersedes the
> "calm-companion" visual language section of
> `docs/specs/2026-07-13-assistant-centered-web-ui-design.md`. Decision
> record, not a full spec — this is a token-layer change, not a rebuild.

## Problem

The product had no single brand identity. Three signals disagreed: the web
app's `theme.css` defined a "calm-companion" palette (warm paper background,
moss green accent, a serif `display` face for headings); the README's hero
illustration (`docs/valet.png`) shows a bright, blue-uniformed mascot; the
actual favicon was an unrelated leftover — a cyan-on-black "A" matching
neither. Meanwhile `tailwind.config.ts` already carried a second, mostly
unused OKLCH `accent`/`neutral` color system (added for newer primitives —
`Badge`, `Button`, `ConfirmDialog`) that happened to be much closer to both
a professional "AI-native" look and the mascot's own blue.

Prompted by a UI reference (an "AI-native interface" component gallery) and
the ask to re-brand around the existing mascot art, this is step one of
that track: pick one identity and retarget the token layer onto it, before
any of the reference's ~19 components get built. Scope decisions: brand
foundation first (component work is separate, later sub-projects); keep the
mascot illustration and wordmark, restyle everything else around it.

## Decision

**One neutral system, one accent, no second palette.**

- `--paper` / `--ink` / `--muted` / `--line` (backgrounds, text, secondary
  text, borders) now point at the same cool-neutral OKLCH scale
  (`tailwind.config.ts`'s `neutral`, hue 247) that `Badge`/`Button` already
  used, instead of a separately maintained warm off-white palette. Light
  mode is a near-white cool gray; dark mode is a near-black cool gray (not
  pitch black) — closer to the reference's dark, technical feel than the
  prior warm dark (`#171614`).
- The brand color is blue, sampled from the mascot's uniform: OKLCH hue 264
  at the saturation the existing `accent` scale already used (chroma
  ~0.18–0.19 at mid-tones). The `accent` Tailwind scale is extended from 5
  stops (50/100/500/600/700) to a full 50–900 ramp, so hover/press/dark-mode
  states have real stops instead of reusing the same 2–3 shades everywhere.
- `--moss` (the CSS variable backing the `moss` Tailwind color) now holds
  the new blue instead of green. **The name is not changed.** It has 47 call
  sites across `packages/web/src`; renaming would be a large, purely
  mechanical diff that changes nothing about how the app looks — the
  value-level change already re-brands every one of those call sites for
  free. Rename it if a future change touches those files for other reasons;
  don't do it solely for the name.
- `--amber` is untouched. It's a narrow semantic marker ("thinking /
  pending" — the presence dot, a couple of status badges), not part of the
  brand identity, and stays that way.
- The `display` font family (headings) drops the serif `Newsreader` stack
  for the same sans stack as body text. **Correction (2026-08-12): this
  section originally claimed Newsreader was never loaded and the change was
  a no-op — that was wrong.** It WAS loaded, via `@import "@fontsource/..."`
  in `styles/globals.css` (missed because the verification grep ran from
  the wrong working directory and silently matched nothing). Every
  `font-display` heading across ~25 files — page titles, section headers,
  the presence mark, memory docs — actually rendered in Newsreader serif,
  and this change genuinely flattened all of them to sans. It was verified
  live afterward (screenshots across Events/Workflows/Teams all show clean
  sans headings, no regressions), so the *result* stands, but the original
  claim about impact was inaccurate. The now-unused `@fontsource/newsreader`
  import and dependency were removed in the same follow-up pass.
- Hover/press "wash" colors (`--ink-wash`, `--moss-wash` and their
  `-strong` variants) are rebuilt with native `oklch(L C H / alpha)` syntax
  at the exact L/C/H of the token they wash, instead of a hand-converted
  `rgba()` hex duplicate. The old form could drift silently from its base
  color; this form can't — change the base token and the wash follows.
- Added a favicon (`packages/web/public/favicon.svg`, a simple blue "V"
  mark on a dark tile — the mascot art itself is too detailed for 16–32px)
  and light/dark `<meta name="theme-color">` tags matching the new
  `--paper` values, replacing the previous absence of both.

## What this does NOT do

- No component work from the UI reference (Thinking traces, Streaming
  Text, Tool Chips, Approval Card, Records/Filter Table, etc.) — that's
  separate, sequenced sub-project work.
- No rename of `moss`/`amber` to brand-accurate names.
- No new logo mark beyond the minimal favicon; the mascot illustration and
  "Valet" wordmark are kept as-is per the scoping decision.
- No changes to spacing, border-radius, or component structure — this pass
  is colors + type only.

## Verification

`pnpm --filter @valet/web build` (production build, exercises the full
Tailwind + PostCSS pipeline) and the existing web test suite both pass with
no changes required elsewhere — confirms the token architecture's actual
value: a full palette swap touching 100+ consuming files required editing
exactly two files (`theme.css`, `tailwind.config.ts`) plus the new favicon
and `index.html` meta tags. Manually verified live against the dev stack,
light and dark, on three component-dense pages (Events activity feed +
subscriptions, the workflow editor's node canvas + Triggers drawer, the
Teams settings panel) — no contrast or legibility regressions.

## Contrast pairs and palette scales (2026-10-30)

The token layer had five defects that every palette shared or that the default palette carried:

- White text on the dark-mode moss measured 2.82:1, so every primary button failed in dark mode.
- An unchecked checkbox and an off switch were drawn with `--line` or a light grey, far under the 3:1 floor for a control's outline (WCAG 1.4.11).
- The grey focus ring on secondary and ghost buttons measured 2.49:1.
- The default `--muted` measured about 4.0:1 in light mode and 3.6:1 in dark mode on an `--ink-wash` row.
- 32 classes named a `danger` or `success` step that the two-step ramps did not define, so they painted no color. Examples are tool-renderer errors, the validation banner, and composer file errors.

Decisions:

- **Contrast pairs.** Every `theme.css` block adds `--on-moss` (text on a moss fill), `--moss-text` (moss-colored text), `--control-border` (the outline of an unchecked control), and `--danger-text` (error text). Light blocks use white for `--on-moss`. Dark blocks use their own `--paper`. `--moss-text` is `var(--moss)` where the moss holds 4.5:1 on `--paper` and on `--moss-wash`, the fill of a selected `RadioCard`. The default and Tide light blocks give it a darker value (52.5% and 49% lightness), because their moss measured 4.496:1 and 4.34:1 on the wash. For the same wash, the Ember, Tide and Orchid light `--muted` is 51.5%, not 52.5%. `theme.tokens.test.ts` measures each pair, and `--muted` on `--paper`, `--ink-wash` and `--moss-wash`, with the WCAG 2.2 contrast ratio.
- **Dark control border.** Dark `--control-border` is 57% lightness, not the planned 55%. At 55%, the thumb of an off `Switch` measured 2.88:1 to 2.99:1 on its `--ink-wash-strong` track. The test measures that pair at 3:1.
- **Default muted.** Light `--muted` is `oklch(50% 0.015 247)`. Dark `--muted` is `oklch(62% 0.015 247)`. This repaints secondary text on an untouched install, on purpose. `--muted-wash` keeps the L/C/H of `--muted`.
- **Primitives.** The primary `Button` is `bg-moss text-on-moss`. `textLinkClass` is `text-moss-text`. An unchecked `Checkbox` has a `control-border` outline. An off `Switch` has a faint track, a 1px `control-border` outline, and a `control-border` thumb. An on `Switch` has a moss track and an `on-moss` thumb. The `FieldRow` and `ConfirmDialog` errors use `text-danger-text`. The `StatusDot` success tone is `bg-success-500`, because `bg-moss` is blue on the default palette.
- **One focus ring.** `FOCUS_RING` in `primitives/control.ts` is a 2px moss ring with a 2px gap in the page color. Every `Button` variant, `Switch`, `Checkbox`, and `RadioCard` use it. Tabs draw a 2px moss ring inset, because the tab strip clips. A selected `RadioCard` is a moss border on a moss wash, with no ring. `:root` sets `accent-color: var(--moss)` for native checkboxes and radios.
- **Palette scales.** Each block sets `--neutral-h`/`--neutral-c` and `--accent-h`/`--accent-c`. Each `neutral` and `accent` step keeps its lightness and takes chroma `var(--*-c)` times its default chroma divided by the default base (0.015 for `neutral`, 0.19 for `accent`). The default palette's values give the same colors as before. The `danger` and `success` ramps stay fixed in every palette and now run from 50 to 900. `tailwind.config.test.ts` fails if a class in `src` names a step that a scale does not define. Status colors do not use `accent`, because under Ember it is rust orange. The `low` security severity uses Tailwind's fixed `blue`, as the `StatusDot` `info` tone does.
- **`iconSm`.** `Button size="iconSm"` is a 32px square that grows to 44px below `md` and under a coarse pointer.

References: shadcn's fill and `-foreground` token pairs (https://github.com/shadcn-ui/ui/tree/main/apps/v4/registry/new-york-v4/ui), Radix color roles (https://www.radix-ui.com/themes/docs/theme/color), WCAG 1.4.11 (https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html), and the Material 3 switch (https://m3.material.io/components/switch/specs).
