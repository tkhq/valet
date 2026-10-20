// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tanstack/react-router")>(),
  Link: ({ to, params, children, className }: { to: string; params?: Record<string, string>; children: ReactNode; className?: string }) => (
    <a href={Object.entries(params ?? {}).reduce((path, [k, v]) => path.replace(`$${k}`, encodeURIComponent(v)), to)} className={className}>{children}</a>
  ),
}));

import { Ref } from "./ref";

describe("Ref", () => {
  it("renders a linked token with a hidden mark", () => {
    render(<Ref kind="workflow" text="Triage failures" to="/workflows/$workflowId" params={{ workflowId: "wf-1" }} />);
    const link = screen.getByRole("link", { name: "Triage failures" });
    expect(link.getAttribute("href")).toBe("/workflows/wf-1");
    expect(link.className).toContain("bg-ink-wash");
    expect(link.className).toContain("hover:bg-moss-wash");
    const mark = link.querySelector("[data-ref-mark]");
    expect(mark?.getAttribute("aria-hidden")).toBe("true");
    expect(mark?.querySelector("svg")?.getAttribute("width")).toBe("12");
  });

  it("renders a token with no page as text", () => {
    const { container } = render(<Ref kind="person" text="Jack" />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(container.textContent).toBe("Jack");
    expect(container.querySelector("[data-ref=person]")?.className).not.toContain("hover:");
  });

  it("marks a place with its service glyph in the service hue, without a tile", () => {
    const { container } = render(<Ref kind="place" service="slack" text="#incidents" />);
    const mark = container.querySelector<HTMLElement>("[data-ref-mark=place]");
    expect(mark?.style.color).toContain("oklch(0.45 0.14 320)");
    expect(mark?.querySelector("[data-service]")).toBeNull();
    expect(mark?.querySelector("path")?.getAttribute("d")).toBe("M9 3v18M15 3v18M3 9h18M3 15h18");
  });

  it("gives each kind its own glyph", () => {
    const { container } = render(<><Ref kind="thread" text="t" /><Ref kind="workflow" text="w" /><Ref kind="person" text="p" /></>);
    const paths = [...container.querySelectorAll("[data-ref-mark] path")].map((p) => p.getAttribute("d"));
    expect(new Set(paths).size).toBe(3);
  });
});
