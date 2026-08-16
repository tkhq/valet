/**
 * The avatar a service, plugin, or skill card shows — a brand mark when the
 * service has one, and the initial-letter monogram when it does not.
 *
 * Why a mark at all: the monogram alone printed one grey letter per card,
 * and Gmail, Google Calendar, and Google Workspace all print "G". Six cards
 * in the Services grid were indistinguishable at a glance.
 *
 * WHERE THE PATHS COME FROM: `simple-icons`, the upstream brand-mark set.
 * The path data is never written here. Each mark is imported by name, so
 * the bundle carries the marks this file names and no others.
 *
 * COLOR: each mark renders in `currentColor`, not in the vendor's brand
 * hex. A brand hex is one fixed colour; the app has a light theme and a
 * dark theme, and a mark like GitHub's near-black disappears on the dark
 * paper. `currentColor` follows the theme token instead, so a mark keeps
 * its contrast in both.
 *
 * The MONOGRAM fallback keeps the brand hue as a tile BACKGROUND with white
 * text, which holds contrast in both themes for the same reason a badge
 * does. Services with no upstream mark (Slack, Typefully, DeepWiki at time
 * of writing) land here and stay distinguishable by colour and letter.
 */
import {
  siCloudflare,
  siFigma,
  siGithub,
  siGmail,
  siGooglecalendar,
  siGoogledocs,
  siGoogledrive,
  siGooglesheets,
  siLinear,
  siNotion,
  siSentry,
  siStripe,
  siTelegram,
} from "simple-icons";
import { cn } from "~/lib/cn";

/** The two fields a mark needs to render. `simple-icons` entries carry more
 * (brand hex, source URL, the full SVG string); this file uses the outline
 * and the brand name only. */
interface BrandMark {
  title: string;
  path: string;
}

/**
 * Slug → mark. Keys are the slugs plugins declare in `plugin.yaml`
 * (`iconSlug`, shipped on `PluginServiceSummary.iconSlug`), plus the plugin
 * ids callers fall back to when a plugin declares no slug of its own.
 */
const BRAND_MARKS: Record<string, BrandMark> = {
  cloudflare: siCloudflare,
  figma: siFigma,
  github: siGithub,
  gmail: siGmail,
  "google-calendar": siGooglecalendar,
  google_calendar: siGooglecalendar,
  "google-docs": siGoogledocs,
  "google-drive": siGoogledrive,
  "google-sheets": siGooglesheets,
  // The Google Workspace plugin reaches Drive, Docs, and Sheets through one
  // credential. Drive is the store the other two write into, so it stands
  // for the set.
  "google-workspace": siGoogledrive,
  google_workspace: siGoogledrive,
  linear: siLinear,
  notion: siNotion,
  sentry: siSentry,
  stripe: siStripe,
  telegram: siTelegram,
};

/** The mark for a slug, or `undefined` when the set has none for it. */
export function brandMark(slug: string | undefined): BrandMark | undefined {
  if (!slug) return undefined;
  return BRAND_MARKS[slug];
}

/** Recognizable brand hues for the monogram tile; unknown services hash
 * into a small default palette so third-party plugins still get a stable
 * color. Full-strength hexes on purpose — the CSS-var tokens can't take
 * opacity modifiers (theme.css trap). */
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

export function brandHex(id: string): string {
  const known = BRAND_HEX[id];
  if (known) return known;
  let h = 5381;
  for (let i = 0; i < id.length; i++) h = ((h << 5) + h + id.charCodeAt(i)) | 0;
  return FALLBACK_HEX[Math.abs(h) % FALLBACK_HEX.length];
}

/**
 * `brand` is the default. `quiet` dims a built-in plugin, which asks
 * nothing of the reader. `accent` marks a skill the caller stores, which
 * belongs to no vendor and therefore never takes a mark.
 */
export type ServiceIconTone = "brand" | "quiet" | "accent";

/**
 * `md` is the card avatar. `sm` is the inline scale, for a run of marks read
 * as one line — the app chain on a workflow template card, where the tile
 * sits beside body text rather than heading it.
 */
export type ServiceIconSize = "sm" | "md";

export interface ServiceIconProps {
  /** Brand slug (`PluginServiceSummary.iconSlug`) or, with no slug on the
   * wire, the plugin or service id. */
  slug?: string;
  /** The name beside the icon. The monogram takes its first letter. */
  label: string;
  tone?: ServiceIconTone;
  size?: ServiceIconSize;
  className?: string;
}

const TILE = "grid shrink-0 place-items-center";
const TILE_SIZE: Record<ServiceIconSize, string> = {
  sm: "h-6 w-6 rounded-md",
  md: "h-9 w-9 rounded-lg",
};
/** The mark insets within its tile; the monogram fills it. */
const MARK_SIZE: Record<ServiceIconSize, string> = {
  sm: "h-3.5 w-3.5",
  md: "h-5 w-5",
};
const MONOGRAM_SIZE: Record<ServiceIconSize, string> = {
  sm: "text-[11px]",
  md: "text-sm",
};

export function ServiceIcon({
  slug,
  label,
  tone = "brand",
  size = "md",
  className,
}: ServiceIconProps) {
  const mark = tone === "accent" ? undefined : brandMark(slug);

  // Decorative: the service name is always beside it in text, so a screen
  // reader that read the icon too would say the name twice.
  if (mark) {
    return (
      <span
        aria-hidden="true"
        data-brand-mark={slug}
        className={cn(
          TILE,
          TILE_SIZE[size],
          "bg-ink-wash",
          tone === "quiet" ? "text-muted" : "text-ink",
          className,
        )}
      >
        <svg viewBox="0 0 24 24" fill="currentColor" className={MARK_SIZE[size]} focusable="false">
          <path d={mark.path} />
        </svg>
      </span>
    );
  }

  const background =
    tone === "quiet" ? "#a8a29b" : tone === "accent" ? undefined : brandHex(slug ?? label);
  return (
    <span
      aria-hidden="true"
      className={cn(
        TILE,
        TILE_SIZE[size],
        MONOGRAM_SIZE[size],
        "font-semibold text-white",
        tone === "accent" && "bg-moss",
        className,
      )}
      style={background ? { backgroundColor: background } : undefined}
    >
      {label.charAt(0).toUpperCase()}
    </span>
  );
}
