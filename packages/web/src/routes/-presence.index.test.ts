import { describe, expect, it, vi } from "vitest";

vi.mock("~/components/presence/places-tab", () => ({ PlacesTab: () => null }));

import { readPlacesSearch } from "./presence.index";

describe("readPlacesSearch", () => {
  it("keeps the All listeners view in the URL as ?view=all", () => {
    expect(readPlacesSearch({ view: "all" })).toEqual({ view: "all" });
  });

  it("reads any other value as the places view", () => {
    expect(readPlacesSearch({})).toEqual({});
    expect(readPlacesSearch({ view: "listeners" })).toEqual({});
    expect(readPlacesSearch(null)).toEqual({});
  });
});
