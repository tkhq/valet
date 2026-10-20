/**
 * The people and places a Presence sentence may name: the viewer, every org
 * member by user id, and every Slack channel on the places list by channel id.
 * A mention line created by someone else reads `When <name> mentions Valet`,
 * and a channel filter saved without a label reads the channel's name
 * (docs/specs/2026-10-16-presence-hub-design.md Part C step 2). The member
 * directory is readable by every member, unlike the admin roster.
 */
import type { PresencePlaceWire } from "@valet/api/wire";
import { usePresencePlaces } from "~/api/presence";
import { useOrgDirectory, useMe } from "~/api/settings";
import type { SentenceNames } from "./sentences";

/** A Slack channel place's subject: `slack:<team>/<channel>`. */
const SLACK_CHANNEL_SUBJECT_RE = /^slack:[^/]+\/([^/]+)$/;

/**
 * Slack channel names by channel id, without `#`, from places such as
 * `{ subject: "slack:T1/C900", label: "#incidents" }`. A place that is not
 * one Slack channel, or that has no name, adds nothing.
 */
export function channelNames(places: readonly Pick<PresencePlaceWire, "subject" | "label">[]): Record<string, string> {
  const channels: Record<string, string> = {};
  for (const place of places) {
    const id = SLACK_CHANNEL_SUBJECT_RE.exec(place.subject)?.[1];
    const name = place.label.trim().replace(/^#/, "");
    // A place whose label is its own id has no name: the api falls back to
    // the id when Slack cannot name the channel. Recording it would print
    // the id as `#C0AK0T8KPPY`; the raw id is the right fallback.
    if (id !== undefined && name.length > 0 && name !== id) channels[id] = name;
  }
  return channels;
}

/**
 * `known` adds places the caller already has, such as a place page's own
 * channel, so its name shows before the places list loads.
 */
export function useSentenceNames(known: readonly Pick<PresencePlaceWire, "subject" | "label">[] = []): SentenceNames {
  const me = useMe();
  const directory = useOrgDirectory();
  const places = usePresencePlaces();
  const members: Record<string, string> = {};
  for (const user of directory.data?.users ?? []) {
    const name = user.name.trim() || user.email;
    if (name.length > 0) members[user.userId] = name;
  }
  const channels = channelNames([...(places.data?.places ?? []), ...known]);
  return { members, channels, ...(me.data?.id !== undefined ? { me: me.data.id } : {}) };
}
