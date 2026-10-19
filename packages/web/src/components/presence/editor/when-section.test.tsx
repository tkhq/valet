// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { CatalogService } from "~/components/events/subscription-match";
import type { WhenService } from "~/components/events/wizard-preview";
import { line } from "../test-fixtures";
import { draftFromLine, newDraft, scheduleCron, type Draft, type EditorMode } from "./draft";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tanstack/react-router")>(),
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));
vi.mock("~/api/events", () => ({
  useFilterOptions: () => ({ data: { options: [], reason: "Connect first." }, isLoading: false }),
}));

import { WhenSection, conditionWords } from "./when-section";

const SERVICES: CatalogService[] = [
  {
    service: "slack",
    entries: [
      { key: "slack.app_mention", description: "Mention", filters: [{ field: "channel" }, { field: "user" }] },
      { key: "slack.message", description: "Message", filters: [{ field: "channel" }] },
      { key: "slack.reaction_added", description: "Reaction", filters: [{ field: "reaction" }] },
    ],
  },
  {
    service: "github",
    entries: [
      { key: "github.pull_request.opened", description: "PR", filters: [{ field: "repo" }] },
      { key: "github.check_run.completed", description: "Check", filters: [{ field: "repo" }, { field: "author" }] },
    ],
  },
];

const INCIDENTS = { subject: "slack:T1/C1", service: "slack" as const, label: "#incidents" };

let latest: Draft | undefined;

function Harness({ initial, mode = { kind: "create" }, connected = new Set<WhenService>(["slack", "github"]) }: {
  initial: Draft;
  mode?: EditorMode;
  connected?: ReadonlySet<WhenService> | null;
}) {
  const [draft, setDraft] = useState(initial);
  latest = draft;
  return (
    <WhenSection
      draft={draft}
      mode={mode}
      onChange={setDraft}
      services={SERVICES}
      catalogLoading={false}
      catalogError={false}
      connected={connected}
    />
  );
}

describe("WhenSection", () => {
  it("offers each service with its mark and disables one that is not connected", () => {
    render(<Harness initial={newDraft({ timezone: "UTC" })} />);
    const services = screen.getByRole("group", { name: "Service" });
    expect(within(services).getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Slack", "GitHub", "LinearConnect first", "On a schedule",
    ]);
    expect((within(services).getByRole("button", { name: /Linear/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(services).getByRole("button", { name: "Slack" }).getAttribute("aria-pressed")).toBe("true");
    expect(services.querySelectorAll('[data-size="md"]')).toHaveLength(4);
  });

  it("lists the common events in words, the rest under More events", () => {
    render(<Harness initial={newDraft({ timezone: "UTC" })} />);
    const events = screen.getByRole("group", { name: "Events" });
    expect(within(events).getByLabelText("Someone mentions Valet")).toBeTruthy();
    expect(within(events).getByText("More events (1)")).toBeTruthy();
    expect(events.textContent).not.toContain("slack.app_mention");
    fireEvent.click(within(events).getByLabelText("Someone mentions Valet"));
    expect([...(latest?.events ?? [])]).toEqual(["slack.app_mention"]);
  });

  it("shows conditions as pills in words and removes one", () => {
    render(<Harness initial={newDraft({ preselected: { place: INCIDENTS }, timezone: "UTC" })} />);
    fireEvent.click(screen.getByLabelText("Someone mentions Valet"));
    const only = screen.getByRole("group", { name: "Only when" });
    expect(within(only).getByText("channel is #incidents")).toBeTruthy();
    // A personal mention line hears only its creator; the pill cannot be removed.
    expect(within(only).getByText("your own mentions")).toBeTruthy();
    expect(within(only).getAllByRole("button", { name: /^Remove/ })).toHaveLength(1);
    fireEvent.click(within(only).getByRole("button", { name: "Remove channel is #incidents" }));
    expect(latest?.conditions).toEqual([]);
  });

  it("keeps a stored creator scope as a pill without a remove", () => {
    const sub = line("l1", {
      eventKeys: ["slack.app_mention"],
      filters: [{ field: "channel", op: "eq", value: "C1", label: "#incidents" }, { field: "user", op: "eq", value: "U1" }],
      target: { kind: "assistant", assistant: "user", follow: true },
    });
    render(<Harness initial={draftFromLine(sub)} mode={{ kind: "edit", line: sub }} />);
    const only = screen.getByRole("group", { name: "Only when" });
    expect(within(only).getByText("your own mentions")).toBeTruthy();
    expect(within(only).queryByText(/user is/)).toBeNull();
    expect(within(only).getAllByRole("button", { name: /^Remove/ })).toHaveLength(1);
  });

  it("adds a condition from the fields the picked events carry", () => {
    render(<Harness initial={newDraft({ timezone: "UTC" })} />);
    fireEvent.click(screen.getByRole("button", { name: "GitHub" }));
    fireEvent.click(screen.getByLabelText("A check completes"));
    fireEvent.click(screen.getByRole("button", { name: "+ Add a condition" }));
    const field = screen.getByLabelText("Condition field") as HTMLSelectElement;
    expect([...field.options].map((o) => o.textContent)).toEqual(["Repository", "Author"]);
    fireEvent.change(field, { target: { value: "author" } });
    fireEvent.change(screen.getByLabelText("Condition value"), { target: { value: "jack" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByText("author is jack")).toBeTruthy();
  });

  it("switching the service drops the place condition (Review Focus 4)", () => {
    render(<Harness initial={newDraft({ preselected: { place: INCIDENTS }, timezone: "UTC" })} />);
    fireEvent.click(screen.getByRole("button", { name: "GitHub" }));
    expect(latest?.service).toBe("github");
    expect(latest?.conditions).toEqual([]);
    expect(screen.queryByText(/#incidents/)).toBeNull();
  });

  it("holds the day and time control for a schedule, which makes the cron", () => {
    render(<Harness initial={newDraft({ preselected: { schedule: true }, timezone: "UTC" })} />);
    expect(screen.queryByRole("group", { name: "Events" })).toBeNull();
    fireEvent.click(screen.getByLabelText("Sat"));
    fireEvent.change(screen.getByLabelText("Time"), { target: { value: "07:30" } });
    expect(latest !== undefined && scheduleCron(latest.schedule)).toBe("30 7 * * 1,2,3,4,5,6");
  });

  it("names a condition in words", () => {
    expect(conditionWords({ id: "1", field: "repo", op: "eq", value: "acme/api" })).toBe("repository is acme/api");
    expect(conditionWords({ id: "2", field: "channel", op: "in", value: "C1, C2", inLabels: { field: "channel", values: ["C1", "C2"], labels: ["#a", "#b"] } })).toBe(
      "channel is #a or #b",
    );
  });
});
