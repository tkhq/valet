// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { DiffView } from "./diff-view";
import { TruncatedText } from "./tool-shell";
import { DiffAdditions } from "./write";

const LONG_TOKEN = "https://example.test/" + "a".repeat(300);

function expectWrappedText(container: HTMLElement) {
  expect(container.className).toContain("whitespace-pre-wrap");
  expect(container.className).toContain("break-words");
  expect(container.querySelectorAll(".whitespace-pre, .overflow-x-auto")).toHaveLength(0);
}

describe("text-file tool output wrapping", () => {
  it("wraps write additions without removing their diff marker", () => {
    const { container } = render(<DiffAdditions text={`Long prose ${LONG_TOKEN}`} />);

    expectWrappedText(container.querySelector("pre")!);
    expect(container.textContent).toContain(LONG_TOKEN);
    expect(container.textContent).toContain("+");
  });

  it("wraps read output while preserving its line number", () => {
    const { container } = render(<TruncatedText text={LONG_TOKEN} numbered wrap />);

    expectWrappedText(container.querySelector("pre")!);
    expect(container.textContent).toContain("1");
    expect(container.textContent).toContain(LONG_TOKEN);
  });

  it("keeps non-file truncated output horizontally scrollable", () => {
    const { container } = render(<TruncatedText text={LONG_TOKEN} />);
    const output = container.querySelector("pre")!;

    expect(output.className).toContain("whitespace-pre");
    expect(output.className).toContain("overflow-x-auto");
    expect(output.className).not.toContain("whitespace-pre-wrap");
    expect(output.className).not.toContain("break-words");
  });

  it("wraps edit diffs without removing added and removed markers", () => {
    const { container } = render(<DiffView before={LONG_TOKEN} after={`Long prose ${LONG_TOKEN}`} />);
    const diffRows = container.querySelector<HTMLDivElement>(".font-mono > div")!;

    expectWrappedText(diffRows);
    expect(container.textContent).toContain("−");
    expect(container.textContent).toContain("+");
  });
});
