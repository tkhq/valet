// @vitest-environment jsdom
/**
 * How it works (docs/specs/2026-10-16-presence-hub-design.md Part D step
 * 1.6): When, Do, and Where, each with its value, one explanation, and a
 * `Change` link that opens the editor on its section, disabled for a viewer
 * who may not change the line.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { HowItWorks, type HowColumn } from "./how-it-works";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tanstack/react-router")>(),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));

const COLUMNS: HowColumn[] = [
  { section: "when", value: [{ kind: "text", text: "a check completes on " }, { kind: "place", text: "acme/api", service: "github", subject: "github:acme/api" }], explanation: "Any branch, any author." },
  { section: "do", value: [{ kind: "text", text: "work on it as " }, { kind: "person", text: "Valet" }], explanation: "Valet reads the event and acts in the thread. It appears as Valet." },
  { section: "where", value: [{ kind: "text", text: "in its own thread" }], explanation: "Every event lands in this line's own thread, so the history stays in one place." },
];

describe("HowItWorks", () => {
  it("shows the three columns in order with their values and explanations", () => {
    render(<HowItWorks columns={COLUMNS} onChange={() => {}} />);
    const section = screen.getByRole("region", { name: "How it works" });
    const columns = Array.from(section.querySelectorAll<HTMLElement>("[data-section]"));
    expect(columns.map((c) => c.dataset.section)).toEqual(["when", "do", "where"]);
    expect(columns[0]?.textContent).toBe("Whena check completes on acme/apiAny branch, any author.Change");
    expect(screen.getByText("Valet reads the event and acts in the thread. It appears as Valet.")).toBeTruthy();
  });

  it("opens the named section from each Change", () => {
    const onChange = vi.fn();
    render(<HowItWorks columns={COLUMNS} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Change Where" }));
    fireEvent.click(screen.getByRole("button", { name: "Change When" }));
    expect(onChange.mock.calls).toEqual([["where"], ["when"]]);
  });

  it("disables every Change for a viewer who may not change the line", () => {
    const onChange = vi.fn();
    render(<HowItWorks columns={COLUMNS} onChange={onChange} readOnly />);
    for (const name of ["Change When", "Change Do", "Change Where"]) {
      expect(screen.getByRole("button", { name }).hasAttribute("disabled")).toBe(true);
    }
    fireEvent.click(screen.getByRole("button", { name: "Change Do" }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
