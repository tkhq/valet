// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { setPublicOrigin, usePublicOrigin } from "./public-origin";

describe("usePublicOrigin", () => {
  afterEach(() => setPublicOrigin(null));

  it("is null until the app entry sets it, then updates every reader", () => {
    const { result } = renderHook(() => usePublicOrigin());
    expect(result.current).toBeNull();
    act(() => setPublicOrigin("https://valet.example.com"));
    expect(result.current).toBe("https://valet.example.com");
  });
});
