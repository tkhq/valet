// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Section } from "./section";

describe("Section", () => {
  it("shows its name, its summary, and Change while closed", () => {
    const onToggle = vi.fn();
    render(<Section id="do" name="Do" summary="work on it" open={false} onToggle={onToggle}><p>body</p></Section>);
    const region = screen.getByRole("region", { name: "Do" });
    expect(region.textContent).toContain("work on it");
    expect(screen.queryByText("body")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Change Do" }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("shows its body and Close while open", () => {
    render(<Section id="do" name="Do" summary="work on it" open onToggle={() => {}}><p>body</p></Section>);
    expect(screen.getByText("body")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close Do" }).textContent).toBe("Close");
  });

  it("mutes a default summary", () => {
    render(<Section id="appears" name="Appears as" summary="Valet" muted open={false} onToggle={() => {}} />);
    expect(screen.getByText("Valet").className).toContain("text-muted");
  });

  it("hides the toggle for a section with nothing to change", () => {
    render(<Section id="where" name="Where" summary="Set by the workflow" open={false} onToggle={() => {}} fixed />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
