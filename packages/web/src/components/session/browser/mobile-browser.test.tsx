// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MobileBrowser } from "./mobile-browser";

vi.mock("./browser-preview-feed", () => ({
  BrowserPreviewFeed: () => <div>Live preview</div>,
}));
vi.mock("./browser-pane", () => ({
  BrowserPane: () => (
    <div>
      Interactive browser
      <textarea aria-label="Browser page input" />
    </div>
  ),
}));

describe("mobile browser", () => {
  it("opens full-screen on request, suspends the preview, and returns to chat without closing the browser", () => {
    render(<MobileBrowser sessionId="s" threadId="t" working />);
    expect(screen.getByText("Live preview")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open browser" }));
    expect(screen.getByRole("dialog", { name: "Browser" })).toBeTruthy();
    expect(screen.getByText("Interactive browser")).toBeTruthy();
    fireEvent.keyDown(
      screen.getByRole("textbox", { name: "Browser page input" }),
      { key: "Escape" },
    );
    expect(screen.getByRole("dialog", { name: "Browser" })).toBeTruthy();
    expect(screen.queryByText("Live preview")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to chat" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("Live preview")).toBeTruthy();
  });
  it("collapses the card without streaming and can restore it", () => {
    render(<MobileBrowser sessionId="s" working />);
    fireEvent.click(
      screen.getByRole("button", { name: "Minimize browser preview" }),
    );
    expect(screen.queryByText("Live preview")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Restore browser preview" }),
    );
    expect(screen.getByText("Live preview")).toBeTruthy();
  });
  it("keeps an idle browser in a small bar and opens it on tap", () => {
    render(<MobileBrowser sessionId="s" working={false} />);
    expect(screen.queryByText("Live preview")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open browser" }));
    expect(screen.getByRole("dialog", { name: "Browser" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to chat" }));
    expect(screen.queryByText("Live preview")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Restore browser preview" }));
    expect(screen.getByText("Live preview")).toBeTruthy();
  });
  it("expands for browser work, respects minimize, and collapses when work stops", () => {
    const { rerender } = render(<MobileBrowser sessionId="s" working={false} />);
    expect(screen.queryByText("Live preview")).toBeNull();
    rerender(<MobileBrowser sessionId="s" working />);
    expect(screen.getByText("Live preview")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Minimize browser preview" }));
    rerender(<MobileBrowser sessionId="s" working />);
    expect(screen.queryByText("Live preview")).toBeNull();
    rerender(<MobileBrowser sessionId="s" working={false} />);
    rerender(<MobileBrowser sessionId="s" working />);
    expect(screen.getByText("Live preview")).toBeTruthy();
    rerender(<MobileBrowser sessionId="s" working={false} />);
    expect(screen.queryByText("Live preview")).toBeNull();
  });
  it("does not close the full browser when the agent finishes", () => {
    const { rerender } = render(<MobileBrowser sessionId="s" working />);
    fireEvent.click(screen.getByRole("button", { name: "Open browser" }));
    rerender(<MobileBrowser sessionId="s" working={false} />);
    expect(screen.getByRole("dialog", { name: "Browser" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to chat" }));
    expect(screen.queryByText("Live preview")).toBeNull();
  });
});
