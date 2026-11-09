import type { SourceRecord } from "@valet/shared";

const SERVICE_NAMES: Record<string, string> = {
  memory: "Memory", web: "Web page", slack: "Slack", slack_user: "Slack", github: "GitHub", gmail: "Gmail", linear: "Linear", notion: "Notion",
  google_drive: "Google Drive", google_docs: "Google Docs", google_sheets: "Google Sheets", google_slides: "Google Slides", google_calendar: "Google Calendar", "google-calendar": "Google Calendar", "google-calendar-events": "Google Calendar", google_calendar_events: "Google Calendar",
};
/** Shown when a source has no link to open. */
export const NO_LINK_TEXT = "No link for this source";
/** A source list longer than this folds the rest behind a button. */
export const SOURCE_FOLD_AFTER = 5;
const unscoped = (text: string) => text.replace(/^team:[^/]+\//, "");
const readable = (text: string) => text.replace(/[-_]+/g, " ").replace(/^./, letter => letter.toUpperCase());

function memoryTitle(raw: string): string {
  const path = unscoped(raw);
  if (path === raw && !/\.mdx?$/i.test(path)) return raw;
  const segments = path.split("/").filter(Boolean);
  const basename = (segments.pop() ?? path).replace(/\.mdx?$/i, "");
  const parent = segments.pop();
  if (parent && /^(readme|index)$/i.test(basename)) return readable(parent);
  if (parent && /^(overview|summary)$/i.test(basename)) return `${readable(parent)} ${basename.toLowerCase()}`;
  return readable(basename);
}

function plainText(text: string): string {
  return text
    .replace(/!?\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/(^|\s)#{1,6}\s+/g, "$1")
    .replace(/(^|\s)(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s*)?/g, "$1")
    .replace(/\*\*|__|~~|`+/g, "")
    .replace(/([*_])([^*_]+)\1/g, "$2")
    .replace(/\s+/g, " ").trim();
}

function withoutRepeatedHeading(excerpt: string, title: string): string {
  const prefix = excerpt.slice(0, title.length);
  if (prefix.toLowerCase() === title.toLowerCase() && (!excerpt[title.length] || /[\s:.\-–—]/.test(excerpt[title.length] ?? ""))) {
    return excerpt.slice(title.length).replace(/^[\s:.\-–—]+/, "");
  }
  return excerpt;
}

/** Display old stored sources without changing their ids, links, or code locations. */
export function sourcePresentation(source: SourceRecord) {
  const title = source.service === "memory" ? memoryTitle(source.title) : source.title;
  // Stored Calendar snippets can include event descriptions with meeting passcodes.
  const calendar = ["google_calendar", "google-calendar", "google_calendar_events", "google-calendar-events"].includes(source.service);
  let excerpt = calendar ? "" : plainText(source.snippet ?? "");
  if (source.service === "memory" && /^\s*#/.test(source.snippet ?? "")) {
    excerpt = withoutRepeatedHeading(excerpt, title);
  }
  if (excerpt.length > 140) excerpt = `${excerpt.slice(0, 139).trimEnd()}…`;
  // Memory paths are already represented by their readable title.
  const location = source.service === "memory" && source.location && (source.location.includes("/") || source.location.startsWith("team:"))
    ? undefined : source.location;
  const service = SERVICE_NAMES[source.service] ?? readable(source.service);
  return { title, excerpt, location, service };
}
