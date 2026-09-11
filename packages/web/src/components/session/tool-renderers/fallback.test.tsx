// @vitest-environment jsdom
import { encode } from "@toon-format/toon";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
      expect(screen.getByText("12")).toBeTruthy();
    },
  );
});
