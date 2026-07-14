/**
 * Open-refetch fix (decision 18): opening the notifications dropdown
 * refetches, closing it does not. Tests the extracted pure handler rather
 * than simulating a Radix pointer sequence in jsdom.
 */
import { describe, expect, it, vi } from "vitest";
import { makeOpenChangeHandler } from "./notifications-bell";

describe("makeOpenChangeHandler", () => {
  it("refetches when the dropdown opens", () => {
    const refetch = vi.fn();
    makeOpenChangeHandler(refetch)(true);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("does not refetch when the dropdown closes", () => {
    const refetch = vi.fn();
    makeOpenChangeHandler(refetch)(false);
    expect(refetch).not.toHaveBeenCalled();
  });
});
