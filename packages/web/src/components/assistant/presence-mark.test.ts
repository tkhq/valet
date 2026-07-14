/**
 * Pure state → class mapping for the presence mark (decision 10). No DOM
 * rendering needed — `presenceDotClassName` is the exported pure function
 * the component calls internally.
 */
import { describe, expect, it } from "vitest";
import { presenceDotClassName } from "./presence-mark";

describe("presenceDotClassName", () => {
  it("maps idle to the idle animation class", () => {
    expect(presenceDotClassName("idle", false)).toBe("presence-dot presence-dot--idle");
  });

  it("maps thinking to the thinking animation class", () => {
    expect(presenceDotClassName("thinking", false)).toBe("presence-dot presence-dot--thinking");
  });

  it("maps working to the working (steady) class", () => {
    expect(presenceDotClassName("working", false)).toBe("presence-dot presence-dot--working");
  });

  it("appends the static modifier under reduced motion, for every state", () => {
    expect(presenceDotClassName("idle", true)).toBe(
      "presence-dot presence-dot--idle presence-dot--static",
    );
    expect(presenceDotClassName("thinking", true)).toBe(
      "presence-dot presence-dot--thinking presence-dot--static",
    );
    expect(presenceDotClassName("working", true)).toBe(
      "presence-dot presence-dot--working presence-dot--static",
    );
  });
});
