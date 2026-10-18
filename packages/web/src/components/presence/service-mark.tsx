/**
 * The mark of a service on a tile tinted with the service's hue, for the
 * wizard's When choices, group headings, and the event picker. GitHub and
 * Linear use the `simple-icons` path that `ServiceIcon` already imports.
 * `simple-icons` has no Slack mark, so Slack gets a drawn four-bar hash. A
 * schedule gets a clock on the ink wash.
 *
 * The washes are alpha colors over the paper token, so one value holds in
 * the light and the dark theme.
 */
import type { CSSProperties } from "react";
import { brandMark } from "~/components/service-icon";
import { cn } from "~/lib/cn";

export type MarkService = "slack" | "github" | "linear" | "schedule";
export type ServiceMarkSize = "sm" | "md" | "lg";

/** Tile and glyph sizes in pixels. */
const SIZES: Readonly<Record<ServiceMarkSize, { tile: number; glyph: number; radius: number }>> = {
  sm: { tile: 16, glyph: 10, radius: 4 },
  md: { tile: 24, glyph: 14, radius: 6 },
  lg: { tile: 28, glyph: 16, radius: 7 },
};

/** The tile wash and the glyph color, per service. Undefined falls back to a theme class. */
const HUES: Readonly<Record<MarkService, { wash?: string; glyph?: string }>> = {
  slack: { wash: "oklch(55% 0.12 320 / 0.14)", glyph: "oklch(45% 0.14 320)" },
  github: { wash: "oklch(50% 0.01 247 / 0.14)" },
  linear: { wash: "oklch(55% 0.14 275 / 0.16)", glyph: "oklch(45% 0.14 275)" },
  schedule: {},
};

/** The glyph color a mark uses outside its tile, as in a reference token. */
export function glyphColor(service: MarkService): string | undefined {
  return HUES[service].glyph;
}

export const SERVICE_NAMES: Readonly<Record<MarkService, string>> = {
  slack: "Slack",
  github: "GitHub",
  linear: "Linear",
  schedule: "On a schedule",
};

/** The glyph alone, in `currentColor`. */
export function ServiceGlyph({ service, size }: { service: MarkService; size: number }) {
  const box = { width: size, height: size };
  if (service === "slack") {
    return (
      <svg viewBox="0 0 24 24" style={box} fill="none" stroke="currentColor" strokeWidth={3.2} strokeLinecap="round" aria-hidden="true" focusable="false">
        <path d="M9 3v18M15 3v18M3 9h18M3 15h18" />
      </svg>
    );
  }
  if (service === "schedule") {
    return (
      <svg viewBox="0 0 24 24" style={box} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true" focusable="false">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </svg>
    );
  }
  const mark = brandMark(service);
  return (
    <svg viewBox="0 0 24 24" style={box} fill="currentColor" aria-hidden="true" focusable="false">
      {mark !== undefined && <path d={mark.path} />}
    </svg>
  );
}

/**
 * The mark on its tile. Beside a visible service name the mark is
 * decorative (`aria-hidden`). Pass `label` when it stands alone, and the
 * tile carries the name as its accessible name.
 */
export function ServiceMark({
  service,
  size = "md",
  label,
  className,
}: {
  service: MarkService;
  size?: ServiceMarkSize;
  /** The accessible name, for a mark with no visible name beside it. */
  label?: string;
  className?: string;
}) {
  const { tile, glyph, radius } = SIZES[size];
  const hue = HUES[service];
  const style: CSSProperties = {
    width: tile,
    height: tile,
    borderRadius: radius,
    ...(hue.wash !== undefined ? { background: hue.wash } : {}),
    ...(hue.glyph !== undefined ? { color: hue.glyph } : {}),
  };
  const theme = service === "schedule" ? "bg-ink-wash text-muted" : service === "github" ? "text-ink" : "";
  const a11y = label !== undefined ? { role: "img", "aria-label": label } : { "aria-hidden": true };
  return (
    <span
      data-service={service}
      data-size={size}
      className={cn("inline-grid flex-none place-items-center", theme, className)}
      style={style}
      {...a11y}
    >
      <ServiceGlyph service={service} size={glyph} />
    </span>
  );
}
