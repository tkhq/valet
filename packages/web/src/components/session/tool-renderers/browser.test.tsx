// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { browserRenderer } from "./browser";
import { pickRenderer } from "./index";

describe("browser tool results", () => {
  it("claims browser catalog and direct tools before the fallback", () => {
    expect(pickRenderer("call_tool", { tool_id: "browser.execute" })).toBe(
      browserRenderer,
    );
    expect(pickRenderer("browser.execute")).toBe(browserRenderer);
    expect(pickRenderer("tool_browser_execute")).toBe(browserRenderer);
    expect(
      pickRenderer("call_tool", { tool_id: "unrelated.execute" }),
    ).not.toBe(browserRenderer);
  });

  it("shows persisted text, image blocks and durable evidence links", () => {
    const data = {
      sessionId: "session/1",
      text: "Found the page",
      artifacts: [
        {
          id: "artifact/1",
          sessionId: "session/1",
          filename: "result.png",
          mimeType: "image/png",
        },
      ],
    };
    render(
      <browserRenderer.Body
        toolName="call_tool"
        args={{
          tool_id: "browser.execute",
          params: { title: "Check page", code: "await browser.tabs.list()" },
        }}
        status="completed"
        result={{
          content: [
            { type: "text", text: JSON.stringify(data) },
            { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
          ],
        }}
      />,
    );
    expect(screen.getByText("Found the page")).toBeTruthy();
    expect(screen.getByAltText("Browser evidence 1").getAttribute("src")).toBe(
      "data:image/png;base64,aGVsbG8=",
    );
    expect(
      screen.getByRole("link", { name: "Open browser" }).getAttribute("href"),
    ).toBe("/sessions/session%2F1?tab=browser");
    expect(
      screen.getByRole("link", { name: "result.png" }).getAttribute("href"),
    ).toBe("/api/sessions/session%2F1/browser/evidence/artifact%2F1");
  });

  it("rejects non-raster image MIME types and untrusted artifact URLs", () => {
    render(
      <browserRenderer.Body
        toolName="browser.execute"
        args={{}}
        status="completed"
        result={{
          data: {
            artifacts: [
              {
                id: "a",
                sessionId: "s",
                filename: "output",
                url: "javascript:alert(1)",
              },
            ],
          },
          content: [
            { type: "image", mimeType: "image/svg+xml", data: "aGVsbG8=" },
          ],
        }}
      />,
    );
    expect(screen.queryByRole("img")).toBeNull();
    expect(
      screen.getByRole("link", { name: "output" }).getAttribute("href"),
    ).toBe("/api/sessions/s/browser/evidence/a");
  });

  it("opens annotation controls only for saved raster evidence with page coordinates", () => {
    const artifacts = [
      {
        id: "image",
        sessionId: "session",
        filename: "page.png",
        mimeType: "image/png",
        documentId: "document",
        width: 800,
        height: 600,
      },
      {
        id: "legacy",
        sessionId: "session",
        filename: "legacy.png",
        mimeType: "image/png",
      },
    ];
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    queryClient.setQueryData(
      ["sessions", "session", "browser", "evidence", "image", "annotations"],
      { annotations: [] },
    );
    render(
      <QueryClientProvider client={queryClient}>
        <browserRenderer.Body
          toolName="browser.execute"
          args={{}}
          status="completed"
          result={{ data: { artifacts } }}
        />
      </QueryClientProvider>,
    );
    expect(
      screen.queryByRole("region", { name: "Annotations for page.png" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Annotate legacy.png" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Annotate page.png" }));
    expect(
      screen.getByRole("region", { name: "Annotations for page.png" }),
    ).toBeTruthy();
  });
});
