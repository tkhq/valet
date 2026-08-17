// @vitest-environment jsdom
/**
 * Thinking part: collapsed by default (dense-chat default, same as a
 * completed tool call), reveals its text on click, renders nothing for an
 * empty string (an engine artifact, not a real thinking part).
 */
import { describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Thinking } from "./thinking";

describe("Thinking", () => {
  it("renders nothing for empty text", () => {
    const { container } = render(<Thinking text="" />);
    expect(container.firstChild).toBeNull();
  });

  it("starts collapsed", () => {
    render(<Thinking text="considering the options" />);
    expect(screen.queryByText("considering the options")).toBeNull();
  });

  it("reveals the text on click", () => {
    render(<Thinking text="considering the options" />);
    fireEvent.click(screen.getByRole("button", { name: "Thinking" }));
    expect(screen.getByText("considering the options")).toBeTruthy();
  });
});
