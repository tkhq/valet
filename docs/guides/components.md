# Reusing components

Search `src/components/primitives/` and existing feature components before adding UI.

- Use existing buttons, badges, status dots, cards, dialogs, inputs, tabs, and loading/error rows.
- Add typed variants or sizes when a primitive almost fits; do not copy it.
- Keep one-off components beside their feature. Promote them when a second real caller appears and update both callers.
- Render work lists with `WorkRow` inside `WorkList` or `WorkSection` so titles, details, and actions align.
- Use `SubSection` from `settings/section.tsx` for titled parts of settings items.
- Use `cardClass`/`Card`, `pageClass`, `FilterChips`, and `TabBar` for their existing layout patterns.
- Use `textLinkClass` for text links and `Button asChild` for links presented as buttons.
- Choose primitive tones/variants. Reserve raw colors for data-driven values such as graph series.
- Compose classes with `cn()`; do not add wrappers solely for styling. See [Styling](./styling.md).

Delete superseded implementations in the same change. Check unused locals with
`pnpm --filter @valet/web exec tsc --noEmit -p . --noUnusedLocals` and verify
export references with `rg` before removal. Preserve test seams and unique coverage
of code that still runs; tests of removed implementations can be removed with them.
