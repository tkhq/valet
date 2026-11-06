// @vitest-environment jsdom
/** `FieldRow`: the label, the hint, and an error announced under the control. */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FieldRow } from "./field-row";

afterEach(cleanup);

describe("FieldRow", () => {
  it("announces the error under the control in danger-text", () => {
    render(
      <FieldRow label="Timezone" hint="Used for schedules." error="Pick a timezone from the list.">
        <input aria-label="Timezone" />
      </FieldRow>,
    );
    expect(screen.getByText("Timezone").textContent).toBe("Timezone");
    expect(screen.getByText("Used for schedules.").classList.contains("text-muted")).toBe(true);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("Pick a timezone from the list.");
    expect(alert.classList.contains("text-danger-text")).toBe(true);
    expect(alert.classList.contains("text-danger-500")).toBe(false);
  });

  it("renders no alert without an error", () => {
    render(
      <FieldRow label="Name">
        <input aria-label="Name" />
      </FieldRow>,
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
