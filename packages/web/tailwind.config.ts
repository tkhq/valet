import type { Config } from "tailwindcss";
import colors from "tailwindcss/colors";
import typography from "@tailwindcss/typography";

/**
 * Design tokens — single source of truth for color, radius, spacing, type.
 * Components consume these via Tailwind class names; we don't hand-pick raw
 * hex values in components.
 */
/**
 * A theme color held in a CSS variable that also takes an opacity, as in
 * `bg-ink/60`. A plain class keeps `var(--x)`; only an explicit opacity
 * mixes the color with transparent. Before this, a slash class on these
 * tokens emitted no CSS at all. A gradient stop (`from-paper`) passes the
 * number 0, so the value is read as a string.
 */
function varColor(name: string) {
  return ({ opacityValue }: { opacityValue?: string | number }): string =>
    opacityValue === undefined || String(opacityValue) === "1" || String(opacityValue).startsWith("var(")
      ? `var(${name})`
      : `color-mix(in oklch, var(${name}) calc(${opacityValue} * 100%), transparent)`;
}

/**
 * One step of a scale that follows the palette. The step keeps its
 * lightness. Its hue and its chroma come from the active `theme.css` block
 * (`--neutral-h`/`--neutral-c` or `--accent-h`/`--accent-c`). `chroma` is
 * the step's chroma on the default palette and `base` is that palette's
 * `--*-c`, so the chroma scales by the step's ratio to the base and the
 * default palette renders the same colors as before.
 */
function paletteStep(scale: "neutral" | "accent", lightness: string, chroma: number, base: number): string {
  return `oklch(${lightness} calc(var(--${scale}-c) * ${chroma} / ${base}) var(--${scale}-h) / <alpha-value>)`;
}

const neutralStep = (lightness: string, chroma: number) => paletteStep("neutral", lightness, chroma, 0.015);
const accentStep = (lightness: string, chroma: number) => paletteStep("accent", lightness, chroma, 0.19);

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  // `dark:` utilities must follow the SAME resolution as theme.css's token
  // blocks (both mechanisms, explicit data-theme winning over the OS): OS
  // dark applies unless data-theme="light"; data-theme="dark" always applies.
  // Without this, Tailwind defaults to media-only and the /settings theme
  // toggle flips the tokens but not `dark:` classes (invisible-text bugs).
  //
  // The palette axis (`data-palette`, see theme.css) does NOT belong in this
  // list. A palette changes color, never polarity, so it composes with both
  // of these selectors as they stand. Adding a palette name here would make
  // `dark:` fire on a light palette.
  darkMode: [
    "variant",
    [
      '@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) & }',
      ':root[data-theme="dark"] &',
    ],
  ],
  theme: {
    extend: {
      keyframes: {
        "browser-agent-click": {
          from: { transform: "scale(0.45)", opacity: "0.9" },
          to: { transform: "scale(1.8)", opacity: "0" },
        },
        "browser-agent-type": { from: { opacity: "0.7" }, to: { opacity: "0" } },
        "working-dot": { "0%, 80%, 100%": { opacity: "0.25" }, "40%": { opacity: "1" } },
        "text-shimmer": { from: { backgroundPosition: "100% 0" }, to: { backgroundPosition: "-100% 0" } },
      },
      animation: {
        "browser-agent-click": "browser-agent-click 550ms ease-out",
        "browser-agent-type": "browser-agent-type 650ms ease-out",
        // The three dots of a working thread row (`ThreadStateMark`), each
        // delayed a little more than the one before it.
        "working-dot": "working-dot 1.2s ease-in-out infinite both",
        "working-dot-2": "working-dot 1.2s ease-in-out 0.2s infinite both",
        "working-dot-3": "working-dot 1.2s ease-in-out 0.4s infinite both",
        // A light band that crosses running text (`Trace` lines).
        "text-shimmer": "text-shimmer 2s linear infinite",
      },
      colors: {
        // Neutral grayscale, OKLCH-tuned for even visual steps. Used for
        // backgrounds, borders, secondary text. Names map to Tailwind's
        // expected scale so we get the standard shade utilities. The hue and
        // chroma follow the palette (`paletteStep`); the base is step 500.
        neutral: {
          50:  neutralStep("98.5%", 0.002),
          100: neutralStep("96.7%", 0.003),
          200: neutralStep("92.9%", 0.005),
          300: neutralStep("86.9%", 0.007),
          400: neutralStep("70.7%", 0.012),
          500: neutralStep("55.4%", 0.015),
          600: neutralStep("44.6%", 0.013),
          700: neutralStep("37.2%", 0.010),
          800: neutralStep("27.8%", 0.008),
          900: neutralStep("20.5%", 0.006),
          950: neutralStep("13.0%", 0.005),
        },
        // Brand blue — hue 264 is the OKLCH hue of the mascot uniform's
        // royal blue (docs/valet.png), so this scale IS the brand color,
        // not a generic "primary" pick. Full ramp so dark-mode text/icon
        // contrast and hover washes have real stops to reach for, not just
        // the original 3-shade button palette. Under another palette the
        // ramp takes that palette's accent hue and chroma; the base is
        // step 600.
        accent: {
          50:  accentStep("97.0%", 0.025),
          100: accentStep("93.2%", 0.045),
          200: accentStep("86.0%", 0.070),
          300: accentStep("78.0%", 0.110),
          400: accentStep("69.0%", 0.150),
          500: accentStep("60.5%", 0.180),
          600: accentStep("53.5%", 0.190),
          700: accentStep("46.5%", 0.180),
          800: accentStep("39.5%", 0.165),
          900: accentStep("32.0%", 0.140),
        },
        // Status is semantics, not brand: these two ramps are the same in
        // every palette. 500 and 600 are the original steps. The other
        // danger steps take the accent ramp's lightness. Before the full
        // ramps, 32 classes named a step that did not exist and painted
        // nothing (`tailwind.config.test.ts` now fails on that).
        danger: {
          50:  "oklch(97.0% 0.014 27 / <alpha-value>)",
          100: "oklch(93.2% 0.032 27 / <alpha-value>)",
          200: "oklch(86.0% 0.065 27 / <alpha-value>)",
          300: "oklch(78.0% 0.110 27 / <alpha-value>)",
          400: "oklch(69.0% 0.175 27 / <alpha-value>)",
          500: "oklch(60.0% 0.220 27 / <alpha-value>)",
          600: "oklch(53.0% 0.220 27 / <alpha-value>)",
          700: "oklch(46.5% 0.190 27 / <alpha-value>)",
          800: "oklch(39.5% 0.160 27 / <alpha-value>)",
          900: "oklch(32.0% 0.130 27 / <alpha-value>)",
        },
        success: {
          50:  "oklch(97.5% 0.025 145 / <alpha-value>)",
          100: "oklch(94.5% 0.050 145 / <alpha-value>)",
          200: "oklch(89.5% 0.085 145 / <alpha-value>)",
          300: "oklch(82.5% 0.120 145 / <alpha-value>)",
          400: "oklch(74.0% 0.145 145 / <alpha-value>)",
          500: "oklch(65.0% 0.150 145 / <alpha-value>)",
          600: "oklch(57.0% 0.150 145 / <alpha-value>)",
          700: "oklch(49.0% 0.130 145 / <alpha-value>)",
          800: "oklch(41.5% 0.110 145 / <alpha-value>)",
          900: "oklch(34.5% 0.090 145 / <alpha-value>)",
        },
        // Calm-companion palette (assistant-centered web UI, decision 9).
        // Backed by CSS variables in `src/theme.css` so light/dark and any
        // future `data-theme` override apply without touching Tailwind.
        paper: varColor("--paper"),
        ink: varColor("--ink"),
        muted: varColor("--muted"),
        line: varColor("--line"),
        moss: varColor("--moss"),
        // DEFAULT keeps `bg-amber` (the token) working while restoring
        // Tailwind's numeric amber scale — a bare `amber: "var(--amber)"`
        // REPLACED the whole palette here and silently killed every
        // `amber-500`-style class in the session components.
        amber: { ...colors.amber, DEFAULT: varColor("--amber") },
        // Pre-mixed hover/press washes: one tuned alpha per theme (see the
        // wash note in `theme.css`).
        "ink-wash": varColor("--ink-wash"),
        "ink-wash-strong": varColor("--ink-wash-strong"),
        "moss-wash": varColor("--moss-wash"),
        "moss-wash-strong": varColor("--moss-wash-strong"),
        // Mid-strength neutral fill for data marks (chart bars, idle dots).
        "muted-wash": varColor("--muted-wash"),
        // Status washes. The `oklch(... / <alpha-value>)` scales above also
        // take an opacity (`bg-success-500/15`); these tokens keep one alpha
        // per theme.
        "success-wash": varColor("--success-wash"),
        "danger-wash": varColor("--danger-wash"),
        "warning-wash": varColor("--warning-wash"),
        "warning-fg": varColor("--warning-fg"),
        // Contrast pairs (see the note in `theme.css`): text on a moss fill,
        // moss-colored text, the outline of an unchecked control, and error
        // text. Each one has a measured floor in `theme.tokens.test.ts`.
        "on-moss": varColor("--on-moss"),
        "moss-text": varColor("--moss-text"),
        "control-border": varColor("--control-border"),
        "danger-text": varColor("--danger-text"),
      },
      fontFamily: {
        sans: [
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "Inter",
          "Segoe UI",
          "sans-serif",
        ],
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Monaco",
          "Consolas",
          "monospace",
        ],
        // Headings share the body sans (2026-08-11 brand refresh). The
        // prior serif `Newsreader` face WAS loaded, so this flattened every
        // `font-display` heading to sans — verified live afterward.
        // See docs/specs/2026-08-11-brand-refresh-design.md.
        display: [
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "Inter",
          "Segoe UI",
          "sans-serif",
        ],
      },
      borderRadius: {
        sm: "0.25rem",
        DEFAULT: "0.375rem",
        md: "0.5rem",
        lg: "0.75rem",
      },
    },
  },
  plugins: [typography],
} satisfies Config;
