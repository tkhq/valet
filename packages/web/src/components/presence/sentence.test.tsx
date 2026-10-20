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

import { GLUE_PULL, Sentence } from "./sentence";
import { TOKEN_PAD_X } from "./ref";
import type { SentencePart } from "./sentences";
import { visibleText } from "./test-fixtures";

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
    expect(visibleText(container)).toBe("When Jack mentions Valet in #incidents, work in the Platform CI thread, then run Triage failures, as Unknown.");
    expect(screen.getByRole("link", { name: "#incidents," }).getAttribute("href")).toBe("/presence/places/slack%3AC900");
    expect(screen.getByRole("link", { name: "Platform CI" }).getAttribute("href")).toBe("/threads/t-ci");
    expect(screen.getByRole("link", { name: "Triage failures," }).getAttribute("href")).toBe("/workflows/wf-1");
    // A person, and a thread with no id, have no page.
    expect(screen.queryByRole("link", { name: "Jack" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Unknown" })).toBeNull();
    expect(container.querySelectorAll("[data-ref-mark]")).toHaveLength(5);
  });

  it("puts no whitespace between a token and the punctuation after it", () => {
    const { container } = render(<Sentence parts={[
      { kind: "text", text: "When a check completes on " },
      { kind: "place", text: "acme/web", service: "github", subject: "github:acme/web" },
      { kind: "text", text: ", work in the " },
      { kind: "thread", text: "Platform CI" },
      { kind: "text", text: "." },
    ]} />);
    expect(visibleText(container)).toBe("When a check completes on acme/web, work in the Platform CI.");
    const glued = [...container.querySelectorAll("[data-glued]")];
    expect(glued.map((span) => visibleText(span))).toEqual(["acme/web,", "Platform CI."]);
    // The token and its punctuation are adjacent nodes: no text node between them.
    for (const span of glued) expect([...span.childNodes].some((n) => n.nodeType === Node.TEXT_NODE)).toBe(false);
    // The pull equals the pill's right padding, in em, so it holds at any font size.
    expect(TOKEN_PAD_X).toBe("px-[0.4em]");
    for (const glue of container.querySelectorAll("[data-glue]")) expect(glue.className).toBe(GLUE_PULL);
    expect(GLUE_PULL).toBe("-ml-[0.2em]");
  });

  it("reads a period after a token with no space in the accessible name", () => {
    render(<h1><Sentence parts={[{ kind: "text", text: "When x, reply, as " }, { kind: "person", text: "Ops Bot" }, { kind: "text", text: "." }]} /></h1>);
    expect(screen.getByRole("heading", { name: "When x, reply, as Ops Bot." })).toBeTruthy();
    // No generic element carries a name: a hidden span reads the token and its period once.
    expect(document.querySelector("[aria-label]")).toBeNull();
    expect([...document.querySelectorAll(".sr-only")].map((span) => span.textContent)).toEqual(["Ops Bot."]);
    expect(document.querySelector("[data-glue]")?.getAttribute("aria-hidden")).toBe("true");
    // A linked token keeps its link, named with its punctuation.
    render(<p><Sentence parts={[{ kind: "text", text: "in " }, { kind: "place", text: "#incidents", service: "slack", subject: "slack:C900" }, { kind: "text", text: ", work" }]} /></p>);
    expect(screen.getByRole("link", { name: "#incidents," })).toBeTruthy();
  });

  it("renders tokens without links when asked", () => {
    render(<p><Sentence parts={parts} links={false} /></p>);
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });
});
