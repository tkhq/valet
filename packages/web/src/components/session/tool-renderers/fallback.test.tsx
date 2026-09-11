// @vitest-environment jsdom
import { encode } from "@toon-format/toon";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { fallbackRenderer } from "./fallback";

const data = { status: "active", count: 12 };

function renderResult(text: string): void {
  render(
    <fallbackRenderer.Body
      toolName="example.list"
      args={{}}
      result={{ content: [{ type: "text", text }] }}
      status="completed"
    />,
  );
}

describe("fallbackRenderer", () => {
  it.each([JSON.stringify(data), encode(data)])(
    "renders JSON and TOON as structured fields",
    (text) => {
      renderResult(text);
      expect(screen.getByText("status")).toBeTruthy();
      expect(screen.getByText("active")).toBeTruthy();
      expect(screen.getByText("count")).toBeTruthy();
      expect(screen.getByText("12")).toBeTruthy();
    },
  );

  it.each([
    "Error: Invalid input",
    "linear.create_issue failed: Invalid input",
    "Ready: no changes",
    "https://example.com/issues/1",
    "Usage: run <command>",
  ])("renders plain output without TOON decoding: %s", (text) => {
    renderResult(text);
    expect(screen.getByText(text)).toBeTruthy();
  });

  it("copies successful plain-string output unchanged", async () => {
    const text = "Ready: no changes";
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    renderResult(text);

    fireEvent.click(screen.getByRole("button", { name: "Copy result" }));
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith(text);
  });
});
