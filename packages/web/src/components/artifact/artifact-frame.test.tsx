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

import {
  ArtifactFrame,
  ArtifactMermaidCoordinator,
  MAX_PENDING_MERMAID_REQUESTS,
} from "./artifact-frame";

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

describe("ArtifactMermaidCoordinator", () => {
  it("coalesces repeated requests and renders the latest replacement", async () => {
    let resolveFirst: (svg: string) => void = () => {};
    const render = vi
      .fn<(source: string, id: string, theme: "default" | "dark") => Promise<string>>()
      .mockImplementationOnce(() => new Promise<string>((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValue('<svg xmlns="http://www.w3.org/2000/svg"><text>latest</text></svg>');
    const postResult = vi.fn();
    const coordinator = new ArtifactMermaidCoordinator(render, postResult);

    coordinator.request("mermaid-0", "first", "default");
    coordinator.request("mermaid-0", "first", "default");
    coordinator.request("mermaid-0", "second", "default");
    coordinator.request("mermaid-0", "latest", "default");

    expect(render).toHaveBeenCalledTimes(1);
    resolveFirst('<svg xmlns="http://www.w3.org/2000/svg"><text>first</text></svg>');

    await waitFor(() => expect(render).toHaveBeenCalledTimes(2));
    expect(render).toHaveBeenLastCalledWith("latest", "artifact-mermaid-2", "default");
    await waitFor(() => expect(postResult).toHaveBeenCalledWith(
      expect.objectContaining({ id: "mermaid-0", svg: expect.stringContaining("latest") }),
    ));
    expect(postResult).toHaveBeenCalledTimes(1);
  });

  it("suppresses a request that already completed", async () => {
    const render = vi
      .fn<(source: string, id: string, theme: "default" | "dark") => Promise<string>>()
      .mockResolvedValue('<svg xmlns="http://www.w3.org/2000/svg" />');
    const postResult = vi.fn();
    const coordinator = new ArtifactMermaidCoordinator(render, postResult);

    coordinator.request("mermaid-0", "same source", "default");
    await waitFor(() => expect(postResult).toHaveBeenCalledTimes(1));

    coordinator.request("mermaid-0", "same source", "default");
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("accepts matching requests after a frame reload and drops stale results", async () => {
    const resolvers: Array<(svg: string) => void> = [];
    const render = vi
      .fn<(source: string, id: string, theme: "default" | "dark") => Promise<string>>()
      .mockImplementation(() => new Promise<string>((resolve) => { resolvers.push(resolve); }));
    const postResult = vi.fn();
    const coordinator = new ArtifactMermaidCoordinator(render, postResult);

    coordinator.request("mermaid-0", "same source", "default");
    coordinator.clear();
    coordinator.request("mermaid-0", "same source", "default");
    expect(render).toHaveBeenCalledTimes(2);

    resolvers[0]?.('<svg xmlns="http://www.w3.org/2000/svg"><text>stale</text></svg>');
    await Promise.resolve();
    expect(postResult).not.toHaveBeenCalled();

    resolvers[1]?.('<svg xmlns="http://www.w3.org/2000/svg"><text>current</text></svg>');
    await waitFor(() => expect(postResult).toHaveBeenCalledWith(
      expect.objectContaining({ svg: expect.stringContaining("current") }),
    ));

    coordinator.clear();
    coordinator.request("mermaid-0", "same source", "default");
    expect(render).toHaveBeenCalledTimes(3);
  });

  it("does not drain pending renders after disposal", async () => {
    let resolveFirst: (svg: string) => void = () => {};
    const render = vi
      .fn<(source: string, id: string, theme: "default" | "dark") => Promise<string>>()
      .mockImplementationOnce(() => new Promise<string>((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValue('<svg xmlns="http://www.w3.org/2000/svg" />');
    const postResult = vi.fn();
    const coordinator = new ArtifactMermaidCoordinator(render, postResult);

    coordinator.request("mermaid-0", "first", "default");
    coordinator.request("mermaid-1", "pending", "default");
    coordinator.dispose();
    coordinator.request("mermaid-2", "ignored", "default");
    resolveFirst('<svg xmlns="http://www.w3.org/2000/svg" />');

    await Promise.resolve();
    expect(render).toHaveBeenCalledTimes(1);
    expect(postResult).not.toHaveBeenCalled();
  });

  it("does not coalesce requests from different blocks", async () => {
    let resolveFirst: (svg: string) => void = () => {};
    const render = vi
      .fn<(source: string, id: string, theme: "default" | "dark") => Promise<string>>()
      .mockImplementationOnce(() => new Promise<string>((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValue('<svg xmlns="http://www.w3.org/2000/svg" />');
    const coordinator = new ArtifactMermaidCoordinator(render, vi.fn());

    coordinator.request("mermaid-0", "same source", "default");
    coordinator.request("mermaid-1", "same source", "default");

    resolveFirst('<svg xmlns="http://www.w3.org/2000/svg" />');
    await waitFor(() => expect(render).toHaveBeenCalledTimes(2));
  });

  it("limits queued requests from one artifact frame", async () => {
    let resolveFirst: (svg: string) => void = () => {};
    const render = vi
      .fn<(source: string, id: string, theme: "default" | "dark") => Promise<string>>()
      .mockImplementationOnce(() => new Promise<string>((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValue('<svg xmlns="http://www.w3.org/2000/svg" />');
    const coordinator = new ArtifactMermaidCoordinator(render, vi.fn());

    coordinator.request("mermaid-0", "first", "default");
    for (let index = 1; index <= MAX_PENDING_MERMAID_REQUESTS + 10; index += 1) {
      coordinator.request(`mermaid-${index}`, `source-${index}`, "default");
    }

    expect(render).toHaveBeenCalledTimes(1);
    resolveFirst('<svg xmlns="http://www.w3.org/2000/svg" />');
    await waitFor(() => expect(render).toHaveBeenCalledTimes(MAX_PENDING_MERMAID_REQUESTS + 1));
  });
});
