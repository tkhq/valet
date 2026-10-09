import { describe, expect, it } from "vitest";
import { cardLabel } from "./deck-state";

describe("cardLabel", () => {
  it("moves the unread count out of the label and drops the shared product name", () => {
    expect(cardLabel("(1) PR Review Automation Options · Valet")).toEqual({ label: "PR Review Automation Options", unread: 1 });
    expect(cardLabel("(12) Chat · Eng Team · Valet")).toEqual({ label: "Chat · Eng Team", unread: 12 });
  });

  it("keeps titles that carry no count, and names an empty one", () => {
    expect(cardLabel("Usage · Valet")).toEqual({ label: "Usage", unread: 0 });
    expect(cardLabel("(draft) notes")).toEqual({ label: "(draft) notes", unread: 0 });
    expect(cardLabel("")).toEqual({ label: "Valet page", unread: 0 });
  });
});
