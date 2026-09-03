// @vitest-environment jsdom
/**
 * `ArtifactFrame` (artifact-pages design). The freeze invariant: a theme
 * flip restamps the running frame via `postMessage` instead of reloading
 * it — reloading would drop script state (comment picker, scroll position).
 * That means `srcDoc` must NOT change when only `theme` changes, across
 * re-renders with the same content props.
 */
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { ArtifactFrame } from "./artifact-frame";

describe("ArtifactFrame", () => {
  it("does not change the iframe's srcDoc when only the theme prop changes", () => {
    const { container, rerender } = render(
      <ArtifactFrame title="Report" rendered="<h1>Hi</h1>" theme="light" />,
    );
    const iframe = container.querySelector("iframe");
    const before = iframe?.getAttribute("srcdoc");
    expect(before).toBeTruthy();

    rerender(<ArtifactFrame title="Report" rendered="<h1>Hi</h1>" theme="dark" />);

    const after = iframe?.getAttribute("srcdoc");
    expect(after).toBe(before);
  });

  it("does change srcDoc when the rendered content changes", () => {
    const { container, rerender } = render(
      <ArtifactFrame title="Report" rendered="<h1>Hi</h1>" theme="light" />,
    );
    const iframe = container.querySelector("iframe");
    const before = iframe?.getAttribute("srcdoc");

    rerender(<ArtifactFrame title="Report" rendered="<h1>Bye</h1>" theme="light" />);

    const after = iframe?.getAttribute("srcdoc");
    expect(after).not.toBe(before);
  });
});
