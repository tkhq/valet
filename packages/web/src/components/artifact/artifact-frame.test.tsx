// @vitest-environment jsdom
/**
 * `ArtifactFrame` (artifact-pages design). The freeze invariant: a theme
 * flip restamps the running frame via `postMessage` instead of reloading
 * it — reloading would drop script state (comment picker, scroll position).
 * That means `srcDoc` must NOT change when only `theme` changes, across
 * re-renders with the same content props.
 */
import { describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";

const renderMermaidMock = vi.hoisted(() => vi.fn());
vi.mock("~/lib/mermaid", () => ({ renderMermaid: renderMermaidMock }));

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

  it("renders Mermaid requests through the shared secure renderer", async () => {
    renderMermaidMock.mockResolvedValue('<svg xmlns="http://www.w3.org/2000/svg"><text>ok</text></svg>');
    const { container } = render(
      <ArtifactFrame
        title="Flow"
        rendered={'<pre><code class="language-mermaid">graph TD; A--&gt;B</code></pre>'}
        theme="light"
      />,
    );
    const iframe = container.querySelector("iframe");
    if (!iframe?.contentWindow) throw new Error("artifact iframe did not mount");
    const postMessage = vi.spyOn(iframe.contentWindow, "postMessage");

    window.dispatchEvent(
      new MessageEvent("message", {
        source: iframe.contentWindow,
        data: { type: "valet-artifact:mermaid", id: "mermaid-0", source: "graph TD; A-->B" },
      }),
    );

    await waitFor(() => expect(renderMermaidMock).toHaveBeenCalledWith(
      "graph TD; A-->B",
      expect.stringMatching(/^artifact-mermaid-/),
      "default",
    ));
    await waitFor(() => expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "valet-artifact:mermaid-result", id: "mermaid-0" }),
      "*",
    ));
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
