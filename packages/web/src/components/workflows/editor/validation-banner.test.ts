import { describe, expect, it } from "vitest";
import { errorNodeIdsFrom } from "./validation-banner";

describe("errorNodeIdsFrom", () => {
  it("extracts a plain node id from a `node \"<id>\":` message", () => {
    expect(errorNodeIdsFrom(['node "llm-1": llm.model must be a non-empty string'])).toEqual(
      new Set(["llm-1"]),
    );
  });

  it("extracts a node id embedded mid-sentence (edge messages)", () => {
    expect(errorNodeIdsFrom(['edge[0]: unknown source node "tool-1"'])).toEqual(new Set(["tool-1"]));
  });

  it("extracts a node id from the `duplicate node id \"<id>\"` phrasing", () => {
    expect(errorNodeIdsFrom(['duplicate node id "set-1"'])).toEqual(new Set(["set-1"]));
  });

  it("reduces a foreach-body synthetic label to the owning foreach id", () => {
    expect(
      errorNodeIdsFrom(['node "foreach-1.body (foreach-1-body)": llm.model must be a non-empty string']),
    ).toEqual(new Set(["foreach-1"]));
  });

  it("collects multiple distinct ids across several messages", () => {
    const errors = [
      'node "llm-1": llm.model must be a non-empty string',
      'node "tool-1": tool.service must be a non-empty string',
    ];
    expect(errorNodeIdsFrom(errors)).toEqual(new Set(["llm-1", "tool-1"]));
  });

  it("returns an empty set for messages naming no node", () => {
    expect(errorNodeIdsFrom(["expected exactly one trigger node, found 0"])).toEqual(new Set());
  });

  it("returns an empty set for an empty error list", () => {
    expect(errorNodeIdsFrom([])).toEqual(new Set());
  });
});
