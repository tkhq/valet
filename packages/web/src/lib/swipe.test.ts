// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { classifySwipe, swipeStartsInProtectedElement } from "./swipe";

describe("classifySwipe", () => {
  it("reads a long horizontal move as a swipe", () => {
    expect(classifySwipe(120, 10)).toBe("right");
    expect(classifySwipe(-120, -10)).toBe("left");
  });
  it("ignores a short move", () => {
    expect(classifySwipe(40, 0)).toBeNull();
  });
  it("ignores a mostly vertical move", () => {
    expect(classifySwipe(80, 70)).toBeNull();
    expect(classifySwipe(-90, 200)).toBeNull();
  });
});

describe("swipeStartsInProtectedElement", () => {
  it("protects text fields", () => {
    document.body.innerHTML = "<div><textarea id=t></textarea><p id=p>x</p></div>";
    expect(swipeStartsInProtectedElement(document.getElementById("t"))).toBe(true);
    expect(swipeStartsInProtectedElement(document.getElementById("p"))).toBe(false);
  });
  it("protects children of a horizontally scrollable element", () => {
    document.body.innerHTML = "<pre id=pre style='overflow-x:auto'><code id=c>x</code></pre>";
    const pre = document.getElementById("pre");
    if (!pre) throw new Error("missing fixture");
    Object.defineProperty(pre, "scrollWidth", { value: 500 });
    Object.defineProperty(pre, "clientWidth", { value: 200 });
    expect(swipeStartsInProtectedElement(document.getElementById("c"))).toBe(true);
  });
  it("accepts null", () => {
    expect(swipeStartsInProtectedElement(null)).toBe(false);
  });
});
