import { describe, expect, it } from "vitest";
import { channelNames } from "./use-sentence-names";
import { filterLabels } from "./sentences";

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

describe("filterLabels with an unnamed channel", () => {
  it("shows the raw id when the places list carries no name for it", () => {
    const names = { channels: channelNames([{ subject: "slack:T1/C0AK0T8KPPY", label: "C0AK0T8KPPY" }]) };
    expect(filterLabels({ field: "channel", op: "eq", value: "C0AK0T8KPPY" }, names)).toEqual(["C0AK0T8KPPY"]);
  });
});
