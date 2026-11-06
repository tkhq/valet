import { describe, expect, it } from "vitest";
import { isDismissSwipe } from "./use-swipe-dismiss";

describe("isDismissSwipe", () => {
  it("closes the drawer on a long, mostly horizontal swipe left", () => {
    expect(isDismissSwipe({ x: 300, y: 400 }, { x: 200, y: 420 }, "left")).toBe(true);
    expect(isDismissSwipe({ x: 300, y: 400 }, { x: 260, y: 400 }, "left")).toBe(false);
    expect(isDismissSwipe({ x: 200, y: 400 }, { x: 300, y: 400 }, "left")).toBe(false);
  });

  it("ignores a vertical scroll in the drawer", () => {
    expect(isDismissSwipe({ x: 300, y: 400 }, { x: 220, y: 600 }, "left")).toBe(false);
  });

  it("closes a sheet on a long, mostly vertical swipe down", () => {
    expect(isDismissSwipe({ x: 100, y: 100 }, { x: 110, y: 200 }, "down")).toBe(true);
    expect(isDismissSwipe({ x: 100, y: 200 }, { x: 100, y: 100 }, "down")).toBe(false);
    expect(isDismissSwipe({ x: 100, y: 100 }, { x: 250, y: 180 }, "down")).toBe(false);
  });
});
