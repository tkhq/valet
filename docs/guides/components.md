# Reusing components

How to keep `packages/web` consistent: one component for each UI concept, with
differences expressed as variants. Two versions of the same thing drift apart,
and a reader then sees two small inconsistencies instead of one pattern.

## Before you build

1. Look in `src/components/primitives/` first. It holds the buttons, badges,
   status dots, cards, dialogs, menus, inputs, tabs, and loading and error rows.
2. Search for a component that already renders the same concept in another
   feature, such as a list row, an empty state, or a status label.
3. Search for your class string. If `rg 'rounded-full bg-blue-500'` finds other
   copies, the concept already exists somewhere.

## Rules

- **One component per concept.** A status mark is `StatusDot`. An action is
  `Button`. A status label is `Badge`. Do not hand-style a `<span>` or
  `<button>` for something a primitive already covers.
- **Add a variant, not a copy.** When a primitive almost fits, add a variant
  or size to it (as `Button` gained `size="icon"`). Keep variants as a typed
  map in the primitive, so every caller picks from the same set.
- **Promote on the second use.** Keep a one-off component beside its feature.
  When a second feature needs the same thing, move it to `primitives/` (or to a
  shared folder) in that change, and switch both callers to it.
- **One layout for one kind of list.** Rows in one list share one row
  component. Work lists render through `WorkRow` inside `WorkList` or
  `WorkSection`: a title link and an optional badge on the first line, the
  time and then the detail on the second, and actions on the right.
- **One heading for one part of a settings item.** A titled part inside a
  settings item, such as a section of an expanded team, uses `SubSection` from
  `settings/section.tsx`: a small title, an optional one-line description, and
  the part's actions on the right.
- **One box, one inset, one column.** A boxed surface uses `cardClass` (or
  `Card`) and starts its content 20px in (`px-5`), the line `WorkRow` titles
  use. A page uses `pageClass` for its width and gutters, so page titles and
  cards start on the same line on every page. Filters with a few choices use
  `FilterChips`; tabs use `TabBar`.
- **Links are not buttons.** Style a text link with `textLinkClass` on a router
  `Link` or an `<a>`. Use `Button asChild` only when a link must look like a
  button.
- **Colours come from tones.** Pick a primitive's tone or variant (`warning`,
  `danger`, `info`). Pass a raw colour class only for data-driven colours that
  no tone covers, such as a graph series.
- **Compose, do not wrap.** Follow [Styling](./styling.md): merge classes with
  `cn()`, and do not create a component only to apply a class list.

## When you replace a pattern

Delete the old code in the same change. After a refactor:

1. Run `pnpm --filter @valet/web exec tsc --noEmit -p . --noUnusedLocals` and
   remove what it reports in the files you touched.
2. Run `npx ts-prune -p packages/web/tsconfig.json` and check each export it
   lists with `rg`. An export that only its own tests use is dead; delete both.

## Sources

- [Composition over inheritance, and variants as configuration (shadcn/ui)](https://vercel.com/academy/shadcn-ui/extending-shadcn-ui-with-custom-components)
- [Variants declared with class-variance-authority](https://tomodahinata.com/en/blog/shadcn-ui-design-system-architecture-production-guide)
- [Fewer, better components; review before adding one](https://medium.com/@romko.kozak/building-reusable-react-components-in-2026-a461d30f8ce4)
- [Do not merge feature components until a pattern repeats](https://dev.to/nainikmehta/stop-making-your-react-components-reusable-react-design-4086)
