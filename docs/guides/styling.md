# Styling

How to style anything in `packages/web`.

## Principles

- **Tailwind first.** New styling uses Tailwind utility classes. No new CSS
  files, no CSS-in-JS.
- **Compose, do not wrap.** Use `cn()` to merge conditional classes. Do not
  create a wrapper component only to apply styles.
- **Tokens for color, utilities for layout.** Color comes from the theme tokens
  in `src/theme.css`. Tailwind utilities handle layout, spacing, and responsive
  behavior.
- **Constraints beat precision.** Use the Tailwind scale rather than arbitrary
  values. `p-4`, not `p-[17px]`.

## Core stack

| Package | Role |
| --- | --- |
| `tailwindcss` | Utility-first CSS |
| `clsx` | Conditional class composition |
| `tailwind-merge` | Resolves conflicting Tailwind classes |
| `@radix-ui/react-*` | Unstyled, accessible primitives |
| `lucide-react` | Icons |
| `@tailwindcss/typography` | Prose blocks (rendered markdown) |

## The `cn()` utility

Every component that accepts a `className` merges it through `cn()`:

```ts
// packages/web/src/lib/cn.ts
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
```

```tsx
<div
  className={cn(
    "rounded-lg border p-4",              // base
    isActive && "border-accent-500",      // conditional
    isDisabled && "cursor-not-allowed opacity-50",
    className,                            // consumer override — always last
  )}
/>
```

`tailwind-merge` resolves conflicts by specificity of intent, not source order:
if the consumer passes `p-2` and the base has `p-4`, the consumer wins. You
never need `!important`.

Put `className` last. It is the consumer's override, and last wins:

```tsx
// Wrong — the base can defeat the consumer's override.
className={cn(className, "p-4")}

// Right — the consumer always wins.
className={cn("p-4", className)}
```

## The primitives layer

`src/components/primitives/` holds the unstyled-primitive layer: `button`,
`badge`, `card`, `dialog`, `input`, `select-menu`, `tooltip`, and friends. Most
wrap a Radix primitive and add tokens.

**Priority order for new UI:**

1. A primitive from `~/components/primitives` if one exists.
2. A composition of primitives in `src/components/`.
3. A Radix primitive wrapped as a new file in `primitives/`, if the pattern will
   recur.
4. A one-off component with Tailwind classes.

Never build a custom control for something `primitives/` already provides, and
never reach past a primitive to style its internals from a consumer.

### Accepting `className` for composition

A primitive takes `className`, merges it, and forwards its remaining props:

```tsx
// packages/web/src/components/primitives/badge.tsx
export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: Variant;
}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { className, variant = "neutral", ...rest },
  ref,
) {
  return (
    <span
      ref={ref}
      className={cn(
        "inline-flex items-center rounded-sm px-1.5 py-0.5 text-[11px] font-medium tracking-wide",
        VARIANT[variant],
        className,
      )}
      {...rest}
    />
  );
});
```

Spreading `...rest` is what keeps `aria-*`, `data-*`, and event handlers working
without the primitive enumerating them.

### Variant patterns

Variants are a `Record` of Tailwind class strings keyed by a union, and the prop
is typed from the record. No runtime theme object, no `cva` dependency:

```tsx
type Variant = "neutral" | "accent" | "success" | "warning" | "danger";

const VARIANT: Record<Variant, string> = {
  neutral: "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
  accent: "bg-accent-100 text-accent-700 dark:bg-accent-700 dark:text-accent-50",
  success: "bg-success-wash text-success-600 dark:text-success-500",
  warning: "bg-warning-wash text-warning-fg",
  danger: "bg-danger-wash text-danger-600 dark:text-danger-500",
};
```

`button.tsx` uses the same shape for `VARIANT` and `SIZE`. Prefer a second
variant key over a boolean prop:

```tsx
// Wrong — booleans multiply, and two of them can contradict.
<Badge isError isMuted />

// Right — one axis, named values, impossible to contradict.
<Badge variant="danger" />
```

### Presentation maps for domain states

When a domain union drives appearance, map the union to presentation once, in
one place, rather than branching at each call site:

```tsx
// packages/web/src/components/run-state-badge.tsx
const PRESENTATION: Record<
  SessionRunState,
  { label: string; variant: Variant; dot?: string }
> = {
  needs_you: { label: "Needs you", variant: "warning" },
  working: { label: "Working", variant: "accent", dot: "animate-pulse motion-reduce:animate-none" },
  failed: { label: "Failed", variant: "danger" },
  sleeping: { label: "Sleeping", variant: "neutral" },
  idle: { label: "Idle", variant: "neutral" },
};
```

The `Record<Union, …>` type is doing real work: add a state to
`SessionRunState` and this fails to compile until you decide how it looks.

## Color tokens

`src/theme.css` is the single source of truth for the palette. `tailwind.config.ts`
exposes the tokens as Tailwind colors (`paper`, `ink`, `muted`, `line`, `moss`,
`accent`, and the `*-wash` variants). Use the token colors rather than raw
Tailwind palette values, so a brand change reaches every surface at once.

### The opacity-modifier trap

Tailwind's slash-opacity syntax (`bg-ink/10`) only works when a theme color is
registered as a function receiving an `<alpha-value>` placeholder. Valet's
tokens are plain color strings pointing at CSS variables, so Tailwind cannot
inject an alpha channel:

```tsx
// Wrong — silently produces NO rule. Not a subtle bug: nothing renders.
<div className="bg-ink/10 hover:bg-moss/20" />

// Right — use the pre-mixed wash token.
<div className="bg-ink-wash hover:bg-moss-wash" />
```

This has already produced an invisible badge and a pill with no background.
When you need a translucent surface, use the `*-wash` token, or add one to
`theme.css` built with native `oklch(... / <alpha>)` at the same lightness,
chroma, and hue as the base token. Do not reach for a hardcoded
`hover:bg-neutral-100 dark:hover:bg-neutral-900` stopgap.

### Dark mode

Every color decision needs both modes. Pair the token with its `dark:` variant
in the same class string, as the variant maps above do, so the two never drift
apart in separate files.

## Icons

`lucide-react` is the icon set. Size and color icons with utilities, not props:

```tsx
import { Check, MoreHorizontal } from "lucide-react";

<Check className="h-4 w-4 text-muted" />;
```

`simple-icons` covers third-party brand marks; `service-icon.tsx` wraps it.

## Responsive design

Tailwind is mobile-first. Unprefixed styles apply everywhere; a prefix applies
at that breakpoint and above:

```tsx
<div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
```

## Accessibility

Radix primitives bring keyboard handling, focus management, and ARIA wiring. You
lose all of it by rebuilding a control out of `div`s:

```tsx
// Wrong — no keyboard support, no focus ring, no role.
<div onClick={close}>Close</div>

// Right — a real button, focusable and announced.
<Button variant="ghost" onClick={close}>Close</Button>
```

Respect reduced motion on anything that animates. `run-state-badge.tsx` pairs
`animate-pulse` with `motion-reduce:animate-none`. Mark decorative elements
`aria-hidden`, as the badge's status dot does.

## Anti-patterns

| Anti-pattern | Why it hurts | Fix |
| --- | --- | --- |
| `bg-token/50` on a theme token | Silently emits no rule | Use the `*-wash` token |
| Arbitrary values (`p-[17px]`) | Breaks the spacing rhythm | Use the scale (`p-4`) |
| `style={{ }}` for layout | Escapes Tailwind and dark mode | Use utility classes |
| `className` first in `cn()` | The base defeats the override | Put `className` last |
| A boolean per visual state | Two booleans can contradict | One `variant` union |
| A wrapper component that only adds classes | Indirection for nothing | Pass `className` |
| Raw palette instead of tokens | Misses the next brand change | Use token colors |
| A hand-built control out of `div`s | No keyboard or ARIA support | Use a Radix primitive |
