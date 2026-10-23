/**
 * The overview's groups (docs/specs/2026-10-16-presence-hub-design.md Part
 * B steps 3, 4, and 8), as pure functions. A block is a mid-grain place (a
 * Slack channel, a GitHub repository, a Linear team) with at least one line
 * of presence, or the service block for the lines that name no single place.
 * A pull request or an issue never gets a block. A line's block is the row
 * key the api sends as `placeKey`; the filters decide only for an older api.
 */
import type { EventSubscriptionWire, PresencePlaceWire } from "@valet/api/wire";
import { isMidGrain, isServiceRoot } from "./places";
import { partsText, text, type SentencePart } from "./sentences";

export type OverviewService = "slack" | "github" | "linear";

export interface PlaceBlockData {
  subject: string;
  label: string;
  service: OverviewService;
  /** True for the block of lines that name no single place. */
  serviceWide: boolean;
  lines: EventSubscriptionWire[];
  activeThreadCount: number;
  lastActivityAt: number | null;
  hasFault: boolean;
}

export interface OverviewGroup {
  service: OverviewService;
  blocks: PlaceBlockData[];
}

/** Past this many blocks, the groups collapse and the filter box shows. */
export const COLLAPSE_THRESHOLD = 10;

/** A group heading's count: `1 place`, `2 places`, `1 routine`, `2 routines`. */
export function countText(count: number, noun: "place" | "routine"): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

const SERVICES: readonly OverviewService[] = ["slack", "github", "linear"];

/** The header of a service block. */
export const SERVICE_BLOCK_LABELS: Readonly<Record<OverviewService, string>> = {
  slack: "Everywhere in Slack",
  github: "Across GitHub",
  linear: "Across Linear",
};

/** The key of a service block when the places list has no service root. */
export const SYNTHETIC_ROOTS: Readonly<Record<OverviewService, string>> = {
  slack: "slack:*",
  github: "github:*",
  linear: "linear:*",
};

/**
 * The filter fields that name one mid-grain place: a row of the overview.
 * Linear's `identifier` is not here, though a sentence reads it as a place
 * (`SENTENCE_PLACE_FIELD_SET`), because it names an issue, which never gets a row.
 */
const MID_GRAIN_PLACE_FIELDS = new Set(["channel", "repo", "team"]);

/** The service a line listens to, from its first event key. */
export function lineService(line: Pick<EventSubscriptionWire, "eventKeys">): OverviewService | null {
  for (const key of line.eventKeys) {
    if (key.startsWith("slack.")) return "slack";
    if (key.startsWith("github.")) return "github";
    if (key.startsWith("linear.")) return "linear";
  }
  return null;
}

const SLACK_CHANNEL = /^slack:[^/]+\/([^/]+)$/;

/**
 * The mid-grain place a line names, or null. A line names a place when it
 * has exactly one place filter (`channel`, `repo`, or `team`), with `eq`
 * and a string value, and the places list has that place.
 */
function namedPlace(line: Pick<EventSubscriptionWire, "filters">, places: readonly PresencePlaceWire[]): PresencePlaceWire | null {
  const filters = line.filters.filter((filter) => MID_GRAIN_PLACE_FIELDS.has(filter.field));
  if (filters.length !== 1) return null;
  const filter = filters[0]!;
  if (filter.op !== "eq" || typeof filter.value !== "string" || filter.value === "") return null;
  const value = filter.value;
  const mids = places.filter(isMidGrain);
  if (filter.field === "repo") return mids.find((place) => place.subject === `github:${value.toLowerCase()}`) ?? null;
  if (filter.field === "team") return mids.find((place) => place.subject === `linear:team/${value}`) ?? null;
  // A channel filter holds the channel id, which the place key carries. A
  // value that is not an id may still be the channel's name.
  const slack = mids.filter((place) => place.service === "slack");
  return slack.find((place) => SLACK_CHANNEL.exec(place.subject)?.[1] === value)
    ?? slack.find((place) => place.label === value || (filter.label !== undefined && place.label === filter.label))
    ?? null;
}

/** The name of the one mid-grain place a line names, or null for a line that names no single place. */
export function namedPlaceLabel(line: Pick<EventSubscriptionWire, "filters">, places: readonly PresencePlaceWire[]): string | null {
  return namedPlace(line, places)?.label ?? null;
}

/**
 * The words that lead a line's fault in the banner (spec Part B step 2):
 * `In <place>,` for a line that names one place, else its service row's
 * name (`Everywhere in Slack,`). A line with no known service has none.
 */
export function faultLead(line: LineRowFields, places: readonly PresencePlaceWire[]): string | null {
  const parts = faultLeadParts(line, places);
  return parts === null ? null : partsText(parts);
}

/** `faultLead` as parts: the named place is a token that links its page. */
export function faultLeadParts(
  line: LineRowFields,
  places: readonly PresencePlaceWire[],
): SentencePart[] | null {
  if (line.placeKey !== undefined) {
    const service = keyService(line.placeKey);
    if (service !== null) {
      const row = places.find((place) => place.subject === line.placeKey);
      if (isMidGrain({ subject: line.placeKey })) return placeLeadParts(row?.label ?? keyLabel(line.placeKey), row?.service ?? service, line.placeKey);
      return [text(`${SERVICE_BLOCK_LABELS[service]},`)];
    }
  }
  const named = namedPlace(line, places);
  if (named !== null) return placeLeadParts(named.label, named.service, named.subject);
  const service = lineService(line);
  return service === null ? null : [text(`${SERVICE_BLOCK_LABELS[service]},`)];
}

/** `In <place>,` with the place as a token. */
export function placeLeadParts(label: string, service: OverviewService, subject: string): SentencePart[] {
  return [text("In "), { kind: "place", text: label, service, subject }, text(",")];
}

/** The service root row of the places list, if it has one. */
function serviceRoot(service: OverviewService, places: readonly PresencePlaceWire[]): PresencePlaceWire | undefined {
  return places.find((place) => place.service === service && isServiceRoot(place));
}

/** The line fields that place a line on a row: the server's row key, and the keys and filters an older api leaves to the web. */
export type LineRowFields = Pick<EventSubscriptionWire, "eventKeys" | "filters" | "placeKey">;

/** The service a row key names, from its prefix. */
function keyService(key: string): OverviewService | null {
  const prefix = key.split(":", 1)[0];
  return prefix === "slack" || prefix === "github" || prefix === "linear" ? prefix : null;
}

/**
 * A mid-grain row's name from its key alone, for a row key the places list
 * does not hold yet (the two reads refresh apart): the channel id, the
 * repository, or the team key.
 */
function keyLabel(key: string): string {
  const slack = SLACK_CHANNEL.exec(key);
  if (slack !== null) return slack[1]!;
  return key.slice(key.indexOf(":") + 1).replace(/^team\//, "");
}

/**
 * The key of the block a line belongs to. The server's `placeKey` wins: it
 * is the row the places read lists the line at. An older api sends no
 * `placeKey`; then the block is the one place the line names, else its
 * service block. A line with no known service has no block.
 */
export function blockSubjectFor(
  line: LineRowFields,
  places: readonly PresencePlaceWire[],
): string | null {
  if (line.placeKey !== undefined && keyService(line.placeKey) !== null) return line.placeKey;
  const named = namedPlace(line, places);
  if (named !== null) return named.subject;
  const service = lineService(line);
  if (service === null) return null;
  return serviceRoot(service, places)?.subject ?? SYNTHETIC_ROOTS[service];
}

/** Newest activity first; blocks with no activity after, by name. */
function compareBlocks(a: PlaceBlockData, b: PlaceBlockData): number {
  if (a.lastActivityAt !== b.lastActivityAt) {
    if (a.lastActivityAt === null) return 1;
    if (b.lastActivityAt === null) return -1;
    return b.lastActivityAt - a.lastActivityAt;
  }
  return a.label.localeCompare(b.label);
}

/**
 * The overview's groups, in the order Slack, GitHub, Linear. Each group
 * holds one block per place with a line, and one service block for the
 * lines that name no single place. A group without a block is dropped.
 * `faults` holds the keys of the blocks with a line that needs attention.
 */
export function overviewGroups(
  places: readonly PresencePlaceWire[],
  lines: readonly EventSubscriptionWire[],
  faults: ReadonlySet<string>,
): OverviewGroup[] {
  const blocks = new Map<string, PlaceBlockData>();
  for (const line of lines) {
    const subject = blockSubjectFor(line, places);
    const eventService = lineService(line);
    if (subject === null || eventService === null) continue;
    let block = blocks.get(subject);
    if (block === undefined) {
      const row = places.find((place) => place.subject === subject);
      // A row key the places list does not hold yet still names a mid-grain row.
      const serviceWide = row === undefined ? !isMidGrain({ subject }) : isServiceRoot(row);
      // The row sets the group, even when the line's keys name another service.
      const service = row?.service ?? keyService(subject) ?? eventService;
      block = {
        subject,
        label: serviceWide ? SERVICE_BLOCK_LABELS[service] : row?.label ?? keyLabel(subject),
        service,
        serviceWide,
        lines: [],
        activeThreadCount: row?.activeThreadCount ?? 0,
        lastActivityAt: row?.lastActivityAt ?? null,
        hasFault: faults.has(subject),
      };
      blocks.set(subject, block);
    }
    block.lines.push(line);
    if (block.service === "slack" && block.serviceWide && line.filters.some((filter) => filter.field === "channel_name")) {
      block.label = "Slack channel responses";
    }
  }
  const groups: OverviewGroup[] = [];
  for (const service of SERVICES) {
    const own = [...blocks.values()].filter((block) => block.service === service).sort(compareBlocks);
    if (own.length > 0) groups.push({ service, blocks: own });
  }
  return groups;
}
