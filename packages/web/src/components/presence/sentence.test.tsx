// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tanstack/react-router")>(),
  Link: ({ to, params, children }: { to: string; params?: Record<string, string>; children: ReactNode }) => (
    <a href={Object.entries(params ?? {}).reduce((path, [k, v]) => path.replace(`$${k}`, encodeURIComponent(v)), to)}>{children}</a>
  ),
}));

import { Sentence } from "./sentence";
import type { SentencePart } from "./sentences";

const parts: SentencePart[] = [
  { kind: "text", text: "When " },
  { kind: "person", text: "Jack" },
  { kind: "text", text: " mentions Valet in " },
  { kind: "place", text: "#incidents", service: "slack", subject: "slack:C900" },
  { kind: "text", text: ", work in the " },
  { kind: "thread", text: "Platform CI", sessionId: "s", threadId: "t-ci" },
  { kind: "text", text: " thread, then run " },
  { kind: "workflow", text: "Triage failures", id: "wf-1" },
  { kind: "text", text: ", as " },
  { kind: "thread", text: "Unknown" },
  { kind: "text", text: "." },
];

describe("Sentence", () => {
  it("reads as the joined text and links each thing to its page", () => {
    const { container } = render(<p><Sentence parts={parts} /></p>);
    expect(container.textContent).toBe("When Jack mentions Valet in #incidents, work in the Platform CI thread, then run Triage failures, as Unknown.");
    expect(screen.getByRole("link", { name: "#incidents" }).getAttribute("href")).toBe("/presence/places/slack%3AC900");
    expect(screen.getByRole("link", { name: "Platform CI" }).getAttribute("href")).toBe("/threads/t-ci");
    expect(screen.getByRole("link", { name: "Triage failures" }).getAttribute("href")).toBe("/workflows/wf-1");
    // A person, and a thread with no id, have no page.
    expect(screen.queryByRole("link", { name: "Jack" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Unknown" })).toBeNull();
    expect(container.querySelectorAll("[data-ref-mark]")).toHaveLength(5);
  });

  it("renders tokens without links when asked", () => {
    render(<p><Sentence parts={parts} links={false} /></p>);
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });
});
