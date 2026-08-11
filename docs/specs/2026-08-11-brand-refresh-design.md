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
  for the same sans stack as body text. This changes nothing about what
  actually renders today — `Newsreader` was never loaded via `@font-face`
  or a stylesheet link, so headings were already silently falling back to
  a generic system serif. The config now says what was already true.
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
