/**
 * The default design system — served when a session has no repository
 * design-tokens.json (and underlying one when it does: repo tokens
 * overlay these). Derived from the Valet app's own theme
 * (packages/web/src/theme.css: paper/ink/muted/line/moss/amber, hue-247
 * neutrals in oklch), so an out-of-the-box design looks like it belongs
 * next to the product. Literal CSS values only — these are set as custom
 * properties on the canvas host.
 */
export const DEFAULT_DESIGN_TOKENS: Record<string, string> = {
  // The Valet palette, verbatim.
  "--paper": "oklch(98.5% 0.002 247)",
  "--ink": "oklch(20.5% 0.006 247)",
  "--muted": "oklch(55.4% 0.015 247)",
  "--line": "oklch(92.9% 0.005 247)",
  "--moss": "oklch(53.5% 0.190 264)",
  "--amber": "#b98a2f",
  "--ink-wash": "oklch(20.5% 0.006 247 / 0.06)",
  "--moss-wash": "oklch(53.5% 0.190 264 / 0.1)",

  // Semantic aliases — the names agents and templates reach for first.
  "--color-bg": "oklch(98.5% 0.002 247)",
  "--color-surface": "#ffffff",
  "--color-fg": "oklch(20.5% 0.006 247)",
  "--color-muted": "oklch(55.4% 0.015 247)",
  "--color-border": "oklch(92.9% 0.005 247)",
  "--color-primary": "oklch(53.5% 0.190 264)",
  "--color-accent": "#b98a2f",
  "--color-success": "oklch(65.0% 0.150 145)",
  "--color-warning": "oklch(45.0% 0.110 75)",
  "--color-danger": "oklch(60.0% 0.220 27)",

  // Dark-surface variants for decks that want the app's dark look.
  "--color-bg-dark": "oklch(13.0% 0.005 247)",
  "--color-fg-dark": "oklch(98.5% 0.002 247)",
  "--color-border-dark": "oklch(27.8% 0.008 247)",
  "--color-primary-dark": "oklch(69.0% 0.150 264)",

  // Type + shape.
  "--font-sans": "system-ui, -apple-system, 'Segoe UI', sans-serif",
  "--font-serif": "Georgia, 'Times New Roman', serif",
  "--font-mono": "ui-monospace, 'SF Mono', Menlo, monospace",
  "--radius": "6px",
  "--radius-lg": "12px",
  "--shadow": "0 1px 3px oklch(20.5% 0.006 247 / 0.12)",
  "--shadow-lg": "0 8px 24px oklch(20.5% 0.006 247 / 0.16)",
};
