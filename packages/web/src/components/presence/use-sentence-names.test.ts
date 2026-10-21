import { describe, expect, it } from "vitest";
import { channelNames, sentenceChannels } from "./use-sentence-names";
import { filterLabels } from "./sentences";
import { place } from "./test-fixtures";

// Review of PR #986: a place whose label is its own channel id carries no
// name, so the sentence must show the raw id, never `#<id>`.
describe("channelNames", () => {
  it("maps a labeled Slack channel to its name without the hash", () => {
    expect(channelNames([{ subject: "slack:T1/C900", label: "#incidents" }])).toEqual({ C900: "incidents" });
  });

  it("skips a place whose label is its own channel id", () => {
    expect(channelNames([{ subject: "slack:T1/C0AK0T8KPPY", label: "C0AK0T8KPPY" }])).toEqual({});
  });

  it("ignores places that are not a single Slack channel", () => {
    expect(channelNames([
      { subject: "slack:T1", label: "Everywhere in Slack" },
      { subject: "github:acme/api", label: "acme/api" },
    ])).toEqual({});
  });
});

describe("filterLabels with a channel name", () => {
  const names = { channels: channelNames([{ subject: "slack:T1/C900", label: "#proj-valet" }]) };

  it("names an exact match", () => {
    expect(filterLabels({ field: "channel", op: "eq", value: "C900" }, names)).toEqual(["#proj-valet"]);
    expect(filterLabels({ field: "channel", op: "in", value: ["C900", "C901"] }, names)).toEqual(["#proj-valet", "C901"]);
  });

  // Review of PR #986: the editor saves the raw id as the label of a channel
  // it could not name, so that label must not hide the name.
  it("prefers the name over a label that is the raw id", () => {
    expect(filterLabels({ field: "channel", op: "eq", value: "C900", label: "C900" }, names)).toEqual(["#proj-valet"]);
    expect(filterLabels({ field: "channel", op: "in", value: ["C900", "C901"], labels: ["C900", "C901"] }, names)).toEqual(["#proj-valet", "C901"]);
    expect(filterLabels({ field: "channel", op: "eq", value: "C900", label: "#ops" }, names)).toEqual(["#ops"]);
  });

  // Review of PR #986: the matcher tests the id against a pattern, so the
  // sentence must show the pattern, not a name the pattern never sees.
  it("keeps a pattern value literal", () => {
    for (const op of ["prefix", "contains", "regex"] as const) {
      expect(filterLabels({ field: "channel", op, value: "C900" }, names)).toEqual(["C900"]);
    }
  });

  // Review of PR #986: a value that is a key on Object.prototype must not
  // read a function off the map and crash the page.
  it("ignores keys inherited from the object prototype", () => {
    for (const value of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(filterLabels({ field: "channel", op: "eq", value }, names)).toEqual([value]);
    }
  });
});

describe("filterLabels with an unnamed channel", () => {
  it("shows the raw id when the places list carries no name for it", () => {
    const names = { channels: channelNames([{ subject: "slack:T1/C0AK0T8KPPY", label: "C0AK0T8KPPY" }]) };
    expect(filterLabels({ field: "channel", op: "eq", value: "C0AK0T8KPPY" }, names)).toEqual(["C0AK0T8KPPY"]);
  });
});

// Dev, 10-21: 8 of a line's 21 channels had no event in 30 days, so they
// were no place, and the sentence showed their raw ids.
describe("sentenceChannels", () => {
  const read = {
    places: [place("slack:T1/C900", "#incidents", "slack", "slack:T1")],
    channelNames: { C06MXK5J1R7: "alerts-prod" },
  };

  it("names a line's channel that is no place from the read's channel names", () => {
    const names = { channels: sentenceChannels(read) };
    expect(filterLabels({ field: "channel", op: "in", value: ["C900", "C06MXK5J1R7", "C0UNKNOWN"] }, names))
      .toEqual(["#incidents", "#alerts-prod", "C0UNKNOWN"]);
  });

  it("adds the places the caller already has, before the read loads", () => {
    expect(sentenceChannels(undefined, [{ subject: "slack:T1/C900", label: "#incidents" }])).toEqual({ C900: "incidents" });
  });
});
