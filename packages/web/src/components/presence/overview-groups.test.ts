/**
 * The overview's groups and blocks (docs/specs/2026-10-16-presence-hub-design.md
 * Part B steps 3, 4, and 8): mid-grain places and service roots only, a
 * line in the block of the one place it names or else in its service
 * block, blocks sorted by last activity and then by name, empty groups
 * dropped, and the faulted places marked.
 */
import { describe, expect, it } from "vitest";
import type { EventSubscriptionFilterWire, EventSubscriptionWire, PresencePlaceWire } from "@valet/api/wire";
import { blockSubjectFor, countText, faultLead, namedPlaceLabel, overviewGroups } from "./overview-groups";
import { place } from "./test-fixtures";


function line(id: string, eventKeys: string[], filters: EventSubscriptionFilterWire[] = []): EventSubscriptionWire {
  return {
    id, name: id, ownerType: "user", ownerId: "u-001", eventKeys, filters,
    target: { kind: "assistant" }, enabled: true, createdBy: "u-001", createdAt: 1, updatedAt: 1,
  };
}

const SLACK_ROOT = place("slack:T1", "Slack", "slack");
const INCIDENTS = place("slack:T1/C900", "#incidents", "slack", "slack:T1", { lastActivityAt: 1_000, activeThreadCount: 2 });
const DEPLOYS = place("slack:T1/C901", "#deploys", "slack", "slack:T1", { lastActivityAt: 5_000 });
const ALERTS = place("slack:T1/C902", "#alerts", "slack", "slack:T1");
const ACME_API = place("github:acme/api", "acme/api", "github", null, { lastActivityAt: 3_000, activeThreadCount: 1 });
const ACME_API_12 = place("github:acme/api#12", "acme/api#12", "github", "github:acme/api", { lastActivityAt: 9_000, activeThreadCount: 1 });
const ENG = place("linear:team/ENG", "ENG", "linear", null);
const LINEAR_ROOT = place("linear:*", "Linear", "linear");

const PLACES = [SLACK_ROOT, INCIDENTS, DEPLOYS, ALERTS, ACME_API, ACME_API_12, LINEAR_ROOT, ENG];

const mention = (id: string, channel?: string) => line(
  id,
  ["slack.app_mention"],
  channel === undefined ? [] : [{ field: "channel", op: "eq", value: channel }],
);

describe("overviewGroups", () => {
  it("keeps mid-grain places with a line, and no pull request block", () => {
    const groups = overviewGroups(PLACES, [
      mention("M", "C900"),
      line("R1", ["github.check_run.completed"], [{ field: "repo", op: "eq", value: "Acme/API" }]),
    ], new Set());
    expect(groups.map((g) => g.service)).toEqual(["slack", "github"]);
    expect(groups[0]!.blocks.map((b) => b.label)).toEqual(["#incidents"]);
    expect(groups[1]!.blocks.map((b) => [b.subject, b.lines.map((l) => l.id)])).toEqual([["github:acme/api", ["R1"]]]);
    expect(groups[1]!.blocks[0]!.activeThreadCount).toBe(1);
    expect(groups[1]!.blocks[0]!.lastActivityAt).toBe(3_000);
  });

  it("puts a line that names no single place in its service block, once (Review Focus 2)", () => {
    const anywhere = mention("A");
    const twoChannels = line("B", ["slack.app_mention"], [{ field: "channel", op: "in", value: ["C900", "C901"] }]);
    const groups = overviewGroups(PLACES, [anywhere, twoChannels, mention("M", "C900")], new Set());
    const slack = groups[0]!;
    const service = slack.blocks.filter((b) => b.serviceWide);
    expect(service).toHaveLength(1);
    expect(service[0]).toMatchObject({ subject: "slack:T1", label: "Everywhere in Slack", serviceWide: true });
    expect(service[0]!.lines.map((l) => l.id)).toEqual(["A", "B"]);
    const all = slack.blocks.flatMap((b) => b.lines.map((l) => l.id));
    expect(all.filter((id) => id === "A")).toHaveLength(1);
  });

  it("names a synthetic service key when the places list has no service root", () => {
    const groups = overviewGroups([ACME_API], [line("G", ["github.pull_request.opened"])], new Set());
    expect(groups[0]!.blocks[0]).toMatchObject({ subject: "github:*", label: "Across GitHub", serviceWide: true, activeThreadCount: 0, lastActivityAt: null });
    const slack = overviewGroups([], [mention("S")], new Set());
    expect(slack[0]!.blocks[0]).toMatchObject({ subject: "slack:*", label: "Everywhere in Slack" });
    const linear = overviewGroups(PLACES, [line("L", ["linear.issue.create"])], new Set());
    expect(linear[0]!.blocks[0]).toMatchObject({ subject: "linear:*", label: "Across Linear" });
  });

  it("matches a Slack channel by its label when the filter value is not a channel id", () => {
    const byLabel = line("N", ["slack.app_mention"], [{ field: "channel", op: "eq", value: "#deploys" }]);
    expect(blockSubjectFor(byLabel, PLACES)).toBe("slack:T1/C901");
    expect(blockSubjectFor(line("T", ["linear.issue.create"], [{ field: "team", op: "eq", value: "ENG" }]), PLACES)).toBe("linear:team/ENG");
  });

  // The server's row key (`placeKey`) for each shape the web's guess got
  // wrong. The line lands on that row, so the row's place page lists it.
  it.each([
    {
      shape: "a repository and a pull request number",
      eventKeys: ["github.pull_request.opened"],
      filters: [{ field: "repo", op: "eq", value: "acme/api" }, { field: "pr_number", op: "eq", value: "12" }],
      placeKey: "github:acme/api",
      label: "acme/api",
    },
    {
      shape: "one channel in an `in` list",
      eventKeys: ["slack.app_mention"],
      filters: [{ field: "channel", op: "in", value: ["C900"] }],
      placeKey: "slack:T1/C900",
      label: "#incidents",
    },
    {
      shape: "a Linear issue identifier",
      eventKeys: ["linear.issue.update"],
      filters: [{ field: "identifier", op: "eq", value: "ENG-4" }],
      placeKey: "linear:team/ENG",
      label: "ENG",
    },
    {
      shape: "a Linear team and an issue identifier",
      eventKeys: ["linear.issue.update"],
      filters: [{ field: "team", op: "eq", value: "ENG" }, { field: "identifier", op: "eq", value: "ENG-4" }],
      placeKey: "linear:*",
      label: "Across Linear",
    },
  ] satisfies { shape: string; eventKeys: string[]; filters: EventSubscriptionFilterWire[]; placeKey: string; label: string }[])(
    "puts a line with $shape on the server's row",
    ({ eventKeys, filters, placeKey, label }) => {
      const sub = { ...line("K", eventKeys, filters), placeKey };
      expect(blockSubjectFor(sub, PLACES)).toBe(placeKey);
      const blocks = overviewGroups(PLACES, [sub], new Set()).flatMap((group) => group.blocks);
      expect(blocks.map((block) => [block.subject, block.label])).toEqual([[placeKey, label]]);
      expect(faultLead(sub, PLACES)).toBe(label.startsWith("Across") ? `${label},` : `In ${label},`);
    },
  );

  it("names a row key the places list does not hold yet by its key", () => {
    const sub = { ...line("R", ["github.push"], [{ field: "repo", op: "eq", value: "acme/web" }]), placeKey: "github:acme/web" };
    const blocks = overviewGroups(PLACES, [sub], new Set()).flatMap((group) => group.blocks);
    expect(blocks.map((block) => [block.subject, block.label, block.serviceWide])).toEqual([["github:acme/web", "acme/web", false]]);
  });

  it("marks the server's row as faulted", () => {
    const sub = { ...line("F", ["slack.app_mention"], [{ field: "channel", op: "in", value: ["C900"] }]), placeKey: "slack:T1/C900" };
    const groups = overviewGroups(PLACES, [sub], new Set(["slack:T1/C900"]));
    expect(groups[0]!.blocks[0]).toMatchObject({ subject: "slack:T1/C900", hasFault: true });
  });

  it("sorts blocks by last activity, newest first, then by name", () => {
    const groups = overviewGroups(PLACES, [mention("a", "C900"), mention("b", "C901"), mention("c", "C902"), mention("d")], new Set());
    expect(groups[0]!.blocks.map((b) => b.label)).toEqual(["#deploys", "#incidents", "#alerts", "Everywhere in Slack"]);
  });

  it("drops a group with no block, and a place with no line", () => {
    const groups = overviewGroups(PLACES, [mention("M", "C900")], new Set());
    expect(groups.map((g) => g.service)).toEqual(["slack"]);
    expect(groups[0]!.blocks).toHaveLength(1);
    expect(overviewGroups(PLACES, [], new Set())).toEqual([]);
  });

  it("marks the blocks in the faulted set", () => {
    const groups = overviewGroups(PLACES, [mention("a", "C900"), mention("b", "C901")], new Set(["slack:T1/C901"]));
    expect(groups[0]!.blocks.map((b) => [b.label, b.hasFault])).toEqual([["#deploys", true], ["#incidents", false]]);
  });
});

describe("countText", () => {
  it("counts places and routines for a group heading", () => {
    expect(countText(1, "place")).toBe("1 place");
    expect(countText(2, "place")).toBe("2 places");
    expect(countText(1, "routine")).toBe("1 routine");
    expect(countText(3, "routine")).toBe("3 routines");
  });
});

describe("namedPlaceLabel", () => {
  it("names the one place a line names, and nothing for a line that names none", () => {
    expect(namedPlaceLabel(mention("a", "C900"), PLACES)).toBe("#incidents");
    expect(namedPlaceLabel({ filters: [] }, PLACES)).toBeNull();
  });
});
