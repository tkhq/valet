import { describe, expect, it } from "vitest";
import {
  browserPoint,
  browserKey,
  browserWheel,
  normalizeBrowserAddress,
} from "./input";

describe("browser input coordinates", () => {
  const viewport = { width: 1280, height: 720 };
  const bounds = { left: 20, top: 30, width: 640, height: 480 };

  it("maps the visible image through letterboxing to CSS pixels", () => {
    expect(browserPoint(340, 270, bounds, viewport)).toEqual({
      x: 640,
      y: 360,
    });
    expect(browserPoint(20, 90, bounds, viewport)).toEqual({ x: 0, y: 0 });
  });

  it("rejects clicks outside the image and zero-size layouts", () => {
    expect(browserPoint(30, 40, bounds, viewport)).toBeNull();
    expect(browserPoint(700, 270, bounds, viewport)).toBeNull();
    expect(browserPoint(20, 30, { ...bounds, width: 0 }, viewport)).toBeNull();
  });

  it("converts wheel line and page units to CSS pixels", () => {
    expect(browserWheel(2, 3, 1, 720)).toEqual({
      type: "wheel",
      deltaX: 32,
      deltaY: 48,
    });
    expect(browserWheel(0, 1, 2, 720)).toEqual({
      type: "wheel",
      deltaX: 0,
      deltaY: 720,
    });
  });
});

describe("browser keys and addresses", () => {
  it("leaves composed text to the IME and maps supported keys", () => {
    expect(browserKey({ key: "Process", isComposing: true })).toBeNull();
    expect(browserKey({ key: "a", isComposing: false })).toBe("a");
    expect(browserKey({ key: " ", isComposing: false })).toBe("Space");
    expect(browserKey({ key: "Dead", isComposing: false })).toBeNull();
  });

  it("adds HTTPS while rejecting script and local-file URLs", () => {
    expect(normalizeBrowserAddress("example.com/a?q=hello")).toBe(
      "https://example.com/a?q=hello",
    );
    expect(normalizeBrowserAddress("http://localhost:3000")).toBe(
      "http://localhost:3000/",
    );
    expect(() => normalizeBrowserAddress("javascript:alert(1)")).toThrow(
      /HTTP/,
    );
    expect(() => normalizeBrowserAddress("file:///etc/passwd")).toThrow(/HTTP/);
  });
});
