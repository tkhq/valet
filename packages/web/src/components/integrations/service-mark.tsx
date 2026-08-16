/**
 * The brand tile for one service — a hued square holding the service's
 * initial. Shared, because a service must read the same everywhere it
 * appears: on its own card under `/integrations`, and in the app chain on a
 * workflow template card.
 *
 * Full-strength hexes on purpose — the CSS-var theme tokens cannot take
 * Tailwind opacity modifiers (see the OPACITY-MODIFIER TRAP note in
 * theme.css), so a wash variant has to be a literal colour too.
 */
import { cn } from "~/lib/cn";
import { displayName } from "./display-name";

/**
 * Recognizable brand hues; unknown services hash into a small default
 * palette so a dropped-in third-party plugin still gets a stable colour
 * instead of a different one on every render.
 */
const BRAND_HEX: Record<string, string> = {
  github: "#24292f",
  gmail: "#ea4335",
  "google-calendar": "#4285f4",
  google_calendar: "#4285f4",
  "google-workspace": "#34a853",
  google_workspace: "#34a853",
  slack: "#611f69",
  linear: "#5e6ad2",
  notion: "#111111",
  sentry: "#362d59",
  stripe: "#635bff",
  cloudflare: "#f6821f",
  deepwiki: "#0ea5e9",
  typefully: "#1d9bf0",
  telegram: "#229ed9",
  figma: "#a259ff",
  browser: "#64748b",
  workflows: "#5f7a5a",
  personas: "#b98a2f",
  "sandbox-tunnels": "#64748b",
};

const FALLBACK_HEX = ["#0ea5e9", "#f97316", "#8b5cf6", "#f43f5e", "#14b8a6", "#6366f1"];

/** The tile colour for a service or plugin id. Stable for a given id. */
export function brandHex(id: string): string {
  const known = BRAND_HEX[id];
  if (known) return known;
  let h = 5381;
  for (let i = 0; i < id.length; i++) h = ((h << 5) + h + id.charCodeAt(i)) | 0;
  return FALLBACK_HEX[Math.abs(h) % FALLBACK_HEX.length];
}

type Size = "sm" | "md";

const SIZE: Record<Size, string> = {
  sm: "h-6 w-6 rounded-md text-[11px]",
  md: "h-9 w-9 rounded-lg text-sm",
};

export function ServiceMark({
  id,
  size = "md",
  quiet,
  className,
}: {
  /** Plugin or credential-service id, e.g. `"gmail"`. */
  id: string;
  size?: Size;
  /** Grey instead of branded — for a plugin that asks nothing of the user. */
  quiet?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid shrink-0 place-items-center font-semibold text-white",
        SIZE[size],
        className,
      )}
      style={{ backgroundColor: quiet ? "#a8a29b" : brandHex(id) }}
    >
      {displayName(id).charAt(0).toUpperCase()}
    </span>
  );
}
