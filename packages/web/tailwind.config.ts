import type { Config } from "tailwindcss";
import colors from "tailwindcss/colors";
import typography from "@tailwindcss/typography";

/**
 * Design tokens — single source of truth for color, radius, spacing, type.
 * Components consume these via Tailwind class names; we don't hand-pick raw
 * hex values in components.
 */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  // `dark:` utilities must follow the SAME resolution as theme.css's token
  // blocks (both mechanisms, explicit data-theme winning over the OS): OS
  // dark applies unless data-theme="light"; data-theme="dark" always applies.
  // Without this, Tailwind defaults to media-only and the /settings theme
  // toggle flips the tokens but not `dark:` classes (invisible-text bugs).
  darkMode: [
    "variant",
    [
      '@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) & }',
      ':root[data-theme="dark"] &',
    ],
  ],
  theme: {
    extend: {
      colors: {
        // Neutral grayscale, OKLCH-tuned for even visual steps. Used for
        // backgrounds, borders, secondary text. Names map to Tailwind's
        // expected scale so we get the standard shade utilities.
        neutral: {
          50:  "oklch(98.5% 0.002 247)",
          100: "oklch(96.7% 0.003 247)",
          200: "oklch(92.9% 0.005 247)",
          300: "oklch(86.9% 0.007 247)",
          400: "oklch(70.7% 0.012 247)",
          500: "oklch(55.4% 0.015 247)",
          600: "oklch(44.6% 0.013 247)",
          700: "oklch(37.2% 0.010 247)",
          800: "oklch(27.8% 0.008 247)",
          900: "oklch(20.5% 0.006 247)",
          950: "oklch(13.0% 0.005 247)",
        },
        // Brand blue — hue 264 is the OKLCH hue of the mascot uniform's
        // royal blue (docs/valet.png), so this scale IS the brand color,
        // not a generic "primary" pick. Full ramp so dark-mode text/icon
        // contrast and hover washes have real stops to reach for, not just
        // the original 3-shade button palette.
        accent: {
          50:  "oklch(97.0% 0.025 264)",
          100: "oklch(93.2% 0.045 264)",
          200: "oklch(86.0% 0.070 264)",
          300: "oklch(78.0% 0.110 264)",
          400: "oklch(69.0% 0.150 264)",
          500: "oklch(60.5% 0.180 264)",
          600: "oklch(53.5% 0.190 264)",
          700: "oklch(46.5% 0.180 264)",
          800: "oklch(39.5% 0.165 264)",
          900: "oklch(32.0% 0.140 264)",
        },
        danger: {
          500: "oklch(60.0% 0.220 27)",
          600: "oklch(53.0% 0.220 27)",
        },
        success: {
          500: "oklch(65.0% 0.150 145)",
          600: "oklch(57.0% 0.150 145)",
        },
        // Calm-companion palette (assistant-centered web UI, decision 9).
        // Backed by CSS variables in `src/theme.css` so light/dark and any
        // future `data-theme` override apply without touching Tailwind.
        paper: "var(--paper)",
        ink: "var(--ink)",
        muted: "var(--muted)",
        line: "var(--line)",
        moss: "var(--moss)",
        // DEFAULT keeps `bg-amber` (the token) working while restoring
        // Tailwind's numeric amber scale — a bare `amber: "var(--amber)"`
        // REPLACED the whole palette here and silently killed every
        // `amber-500`-style class in the session components.
        amber: { ...colors.amber, DEFAULT: "var(--amber)" },
        // Pre-mixed hover/press washes — see the opacity-modifier-trap
        // comment in `theme.css` for why these exist instead of
        // `bg-ink/10`-style opacity modifiers on the tokens above.
        "ink-wash": "var(--ink-wash)",
        "ink-wash-strong": "var(--ink-wash-strong)",
        "moss-wash": "var(--moss-wash)",
        "moss-wash-strong": "var(--moss-wash-strong)",
        // Status washes. `success`/`danger` above are raw `oklch(...)`
        // strings, so `bg-success-500/15` emitted no rule at all and those
        // badges rendered with no background. Alpha lives in the token.
        "success-wash": "var(--success-wash)",
        "danger-wash": "var(--danger-wash)",
        "warning-wash": "var(--warning-wash)",
        "warning-fg": "var(--warning-fg)",
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
        // Headings share the body sans (2026-08-11 brand refresh — the
        // prior serif `display` face was never actually loaded, so this
        // changes nothing about what renders today, only the fallback
        // intent). See docs/specs/2026-08-11-brand-refresh-design.md.
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
