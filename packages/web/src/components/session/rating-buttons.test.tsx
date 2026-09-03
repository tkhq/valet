// @vitest-environment jsdom
/**
 * Toggle semantics for the 👍/👎 pair (TKAI-334): clicking a thumb sets that
 * rating, clicking the ACTIVE thumb clears it (rates null), and the active
 * state is exposed through aria-pressed.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "~/components/primitives";
import { RatingButtons } from "./rating-buttons";

function renderButtons(value: "positive" | "negative" | null, onRate = vi.fn()) {
  render(
    <TooltipProvider>
      <RatingButtons subject="session" value={value} onRate={onRate} />
    </TooltipProvider>,
  );
  return onRate;
}

describe("RatingButtons", () => {
  it("rates positive on a fresh 👍 click", () => {
    const onRate = renderButtons(null);
    fireEvent.click(screen.getByRole("button", { name: "Good session" }));
    expect(onRate).toHaveBeenCalledWith("positive");
  });

  it("clears when the active thumb is clicked again", () => {
    const onRate = renderButtons("positive");
    fireEvent.click(screen.getByRole("button", { name: "Good session" }));
    expect(onRate).toHaveBeenCalledWith(null);
  });

  it("switches straight from 👍 to 👎", () => {
    const onRate = renderButtons("positive");
    fireEvent.click(screen.getByRole("button", { name: "Bad session" }));
    expect(onRate).toHaveBeenCalledWith("negative");
  });

  it("marks the active thumb with aria-pressed", () => {
    renderButtons("negative");
    expect(screen.getByRole("button", { name: "Good session" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "Bad session" }).getAttribute("aria-pressed")).toBe("true");
  });
});
