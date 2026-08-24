# Design craft — how to make work that looks professional

You are designing on a fixed 1920×1080 stage. These rules are not optional
polish; they are the difference between a slide that looks designed and a
slide that looks generated.

## Composition (the #1 failure mode is dead space)

- Compose to FILL the stage. Content pinned to the top quarter with 70% empty
  below reads as broken. Either center the content block vertically, or scale
  it up until it owns the space.
- Padding: 96px on all sides. Content lives inside that frame.
- One idea per slide. A slide is a billboard, not a document: headline, an
  optional one-line kicker, and at most 4 supporting items or ONE artifact
  (a chart, a table, a code block). Everything else you want to say goes in
  data-speaker-notes.
- Align to a grid. Two columns (55/45), a 2×2 or 3-up card grid, or one
  centered block. Never scatter elements at ad-hoc positions.
- Whitespace between groups: 24 / 32 / 48px steps. Consistent gaps, not
  eyeballed ones.

## Type scale (at 1920×1080 — absolute px)

- Deck title: 96–132px. Section/divider titles: 80–96px. Slide headlines:
  56–72px. Body: 28–36px. Kickers/eyebrows: 26–28px uppercase with 0.08em
  letter-spacing. Mono/code: 24–28px. Chart labels: minimum 24px.
- NEVER go below 24px anywhere. If content does not fit at these sizes, cut
  content — do not shrink type. Shrinking type to fix overflow is how decks
  become unreadable.
- One display face for headlines, one text face for body, mono for code.
  Use var(--font-sans) / var(--font-mono) unless the design system provides
  others.

## Color

- Pick ONE background family for the whole deck — light (var(--color-bg)) or
  dark (var(--color-bg-dark)) — plus at most one inverted divider style.
  Alternating random backgrounds reads as chaos.
- Use tokens: var(--color-primary) for the one accent, var(--color-muted)
  for secondary text, semantic colors (--color-success/warning/danger) ONLY
  for status meaning, never decoration.
- Contrast: body text at full foreground; secondary at muted. Never put
  muted-on-muted or accent text below 28px.

## Slide archetypes (use these shapes)

- Title: eyebrow top-left, huge headline in the lower-left or centered,
  metadata line at the bottom. Lots of air.
- Divider: act/section number in mono accent, one huge word or phrase,
  optionally a subtle full-bleed background motif.
- Content: headline top, then the grid (2-col, cards, or one artifact).
- Data: the chart IS the slide. Draw inline SVG at stage scale, label
  directly (min 24px), skip legends when direct labels work.
- Closing: one line, centered, plus the smallest possible footer.

## Discipline

- The canvas report (design_read) is the acceptance test: no hidden slides,
  no clipped slides, no slides that leave most of the stage empty.
- Keep the deck's visual system consistent: same padding, same heading
  position, same card style on every slide. Consistency reads as design.
